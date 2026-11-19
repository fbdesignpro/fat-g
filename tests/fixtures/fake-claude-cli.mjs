// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Deterministic stand-in for the Claude CLI, driven through fat-g's production Claude adapter, its
// own control client and the real process layer — by tests and smoke only. It never reads real
// configuration or credentials: its only inputs are argv and files inside its own --fixture-dir.
//
//   <node> fake-claude-cli.mjs --fixture-dir <dir> --version | auth status | <control session args> | <chat session args> | <secretary args>
//
// A control session starts only for EXACTLY the arguments Agent SDK 0.3.278 used (recorded in
// claude/sdk-0.3.278-wire.json), and a chat session only for exactly the arguments decision 0020
// fixes (claude/replay.mjs, M16), under one of M22's five launches — a permission mode's word and a
// tool list, `CHAT_LAUNCHES` there; anything else exits 64 and writes `unexpected-args`.
//
// A secretary's process (M26; decision 0028) starts only for exactly its fixed arguments, then
// `--model` and an optional `--effort`, and replays M26's K1 capture: the `initialize` reply, then
// at the one prompt the turn's frames. It records, under the role `secretary`, what it was launched
// with and whether `initialize` carried one system prompt, and writes `secretary-prompts`; with
// control.json's `secretaryHang` it answers no prompt, with `secretaryEmpty` it sends no text, and
// with `secretaryRequest` it asks fat-g something, which must be refused (`secretary-request-refused-<pid>`).
//
// A chat session replays the captures under claude/captures (claude/replay.mjs, which lists its
// controls and its environment). It takes no account's lock and writes no `prompts`: both stay what
// a control session must never have, a second session at once and a prompt. From M22 it is the one
// thing here that writes outside the fixture folder, and only where a test let it: for a request
// fat-g answered with an allow it makes that request's change — a file written, edited or touched —
// in the folder it was started in, its scratch project, and nowhere else.
//
// <dir>/auth-state     subscription | logged-out | api-key | cloud | malformed | crash
// <dir>/usage-shape    full | named | unavailable | empty-limits | visual (screenshot review)
// <dir>/control.json   one-shot counters, each consumed by the next SDK session(s):
//                      withholdInit, hangUsage, unsupportedUsage, stuck (ignore EOF + descendant),
//                      malformed (a non-JSON stdout line carrying the private sentinel),
//                      crashSession (exit during initialization),
//                      cliRequest (send a control request of our own; fat-g must refuse it)
// <dir>/accounts.json  optional (M14b, C54): the accounts, by configuration folder. Its keys are the
//                      values CLAUDE_CONFIG_DIR may have; the fake uses that value as a key only and
//                      opens nothing in the folder. An entry:
//                        { "state": "subscription" | "logged-out", "email", "organization", "plan",
//                          "usage": { "session", "weekly", "scoped" } (used percents),
//                          "models": [keys of the captured models it lists],
//                          "efforts": { "<model key>": [captured levels it lists] } }
//                      A folder with no entry reads as not signed in. With the variable unset the
//                      entry is the one under "default", and without one the fake answers as it does
//                      with no accounts.json at all: from auth-state and the constants.
// Written back: pids ("<pid> <role> <started>"), exited ("<pid> <started>" of each normal exit),
// env-<role>-<pid>.json, hung-<pid>, withheld-<pid>, overlaps, prompts, unexpected-args,
// sdk-markers (the Agent SDK's identity reached a session), cli-request-refused-<pid>,
// cli-request-accepted; and by a chat session, under the role `chat`: prompt-without-id,
// unexpected-chat-request and, from M22, unexpected-permission-update — an allow that carried
// anything but the CLI's own rules for the session — each for something a chat session must never
// send.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { createChatReplay, parseChatArgs } from './claude/replay.mjs';

const constants = JSON.parse(readFileSync(path.join(import.meta.dirname, 'claude', 'fake-cli-constants.json'), 'utf8'));
const SENTINEL = constants.sentinel;
const FIXTURE_VERSION = constants.version;
const FIXTURE_EMAIL = constants.email;
const FIXTURE_ORGANIZATION = constants.organization;
const CONTROL_ARGS = JSON.parse(readFileSync(path.join(import.meta.dirname, 'claude', 'sdk-0.3.278-wire.json'), 'utf8')).spawn.args;
const SDK_MARKERS = ['CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_AGENT_SDK_VERSION'];
/** The secretary's fixed arguments (src/main/providers/claude/secretary.ts, SECRETARY_ARGS): a copy, so that a change there fails here. */
const SECRETARY_ARGS = ['--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json', '--setting-sources=', '--strict-mcp-config', '--no-session-persistence', '--tools', '', '--thinking', 'disabled'];
// The `initialize` reply's models and fast-mode fields, as M10's idle discovery session recorded them (M13).
const MODELS = JSON.parse(readFileSync(path.join(import.meta.dirname, 'claude', 'models.json'), 'utf8'));

const args = process.argv.slice(2);
let dir;
if (args[0] === '--fixture-dir') dir = args.splice(0, 2)[1];
const file = (name) => (dir ? path.join(dir, name) : undefined);
// Each process is identified by its PID and its own start time: Windows recycles PIDs within one
// smoke run, so a PID alone cannot say which process it was. A normal exit is recorded under that
// identity; a killed process records nothing and must be proven gone.
const STARTED = Date.now();
process.on('exit', () => append('exited', `${process.pid} ${STARTED}\n`));

// The configuration folder this process was started with, as a value only (M14b, C54).
const CONFIG_FOLDER = (() => {
  const name = Object.keys(process.env).find((candidate) => candidate.toUpperCase() === 'CLAUDE_CONFIG_DIR');
  const value = name === undefined ? undefined : process.env[name];
  return value === undefined || value === '' ? undefined : value;
})();
/** One folder under two spellings is one key: a trailing separator, and on Windows letter case and `/`. */
const folderKey = (folder) => {
  const trimmed = folder.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? trimmed.replaceAll('/', '\\').toLowerCase() : trimmed;
};
// { kind: 'as-before' } | { kind: 'signed-out' } | { kind: 'entry', entry }
const ACCOUNT = chooseAccount();

if (args[0] === 'descendant') {
  record('descendant');
  setInterval(() => {}, 1000);
} else if (args[0] === '--version') {
  record('version'); captureEnv('version');
  process.stdout.write(`${FIXTURE_VERSION} (Claude Code)\n`);
} else if (args[0] === 'auth' && args[1] === 'status') {
  record('auth'); captureEnv('auth');
  if (ACCOUNT.kind === 'as-before') authStatus(readText('auth-state', 'subscription'));
  else authStatus(signedIn() ? 'subscription' : 'logged-out', ACCOUNT.entry);
} else if (args.length === CONTROL_ARGS.length && args.every((arg, index) => arg === CONTROL_ARGS[index])) {
  session();
} else if (parseSecretaryArgs(args) !== null) {
  secretary(parseSecretaryArgs(args));
} else if (parseChatArgs(args) !== null) {
  chat(parseChatArgs(args));
} else if (args.includes('--input-format')) {
  write('unexpected-args', 'unexpected');
  process.exitCode = 64;
} else {
  process.exitCode = 2;
}

function chooseAccount() {
  const text = readText('accounts.json', '');
  if (text === '') return { kind: 'as-before' };
  let accounts;
  try { accounts = JSON.parse(text); } catch { accounts = null; }
  if (accounts === null || typeof accounts !== 'object' || Array.isArray(accounts)) {
    // A test's own mistake: say so loudly, never guess an account.
    write('unexpected-accounts', 'accounts.json is not an object');
    process.exit(65);
  }
  if (CONFIG_FOLDER === undefined) return accounts.default ? { kind: 'entry', entry: accounts.default } : { kind: 'as-before' };
  const found = Object.entries(accounts).find(([key]) => key !== 'default' && folderKey(key) === folderKey(CONFIG_FOLDER));
  return found ? { kind: 'entry', entry: found[1] } : { kind: 'signed-out' };
}

/** Whether the chosen account is a signed-in subscription. Only meaningful with an accounts.json. */
function signedIn() {
  return ACCOUNT.kind === 'entry' && (ACCOUNT.entry.state ?? 'subscription') === 'subscription';
}

/** The captured `initialize` models, with the rows and levels an account does not list left out by name. */
function modelsFor(entry) {
  if (!entry || (entry.models === undefined && entry.efforts === undefined)) return MODELS;
  const models = MODELS.models
    .filter((model) => entry.models === undefined || entry.models.includes(model.value))
    .map((model) => {
      const levels = entry.efforts?.[model.value];
      return levels === undefined || !Array.isArray(model.supportedEffortLevels) ? model : { ...model, supportedEffortLevels: model.supportedEffortLevels.filter((level) => levels.includes(level)) };
    });
  return { ...MODELS, models };
}

function authStatus(state, entry = {}) {
  const base = { apiProvider: 'firstParty', analyticsDisabled: true, configDirectory: `C:\\${SENTINEL}\\config`, projectsDirectory: `C:\\${SENTINEL}\\projects` };
  const out = (value, code) => { process.stdout.write(`${JSON.stringify(value)}\n`); process.exitCode = code; };
  switch (state) {
    case 'logged-out': return out({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' }, 1);
    case 'api-key': return out({ ...base, loggedIn: true, authMethod: 'api_key' }, 0);
    case 'cloud': return out({ ...base, loggedIn: true, authMethod: 'third_party', apiProvider: 'bedrock' }, 0);
    case 'malformed': process.stdout.write(`not json ${SENTINEL}\n`); process.exitCode = 0; return;
    case 'crash': process.exitCode = 3; return;
    default: return out({
      ...base, loggedIn: true, authMethod: 'claude.ai', subscriptionType: entry.plan ?? 'max',
      email: entry.email ?? FIXTURE_EMAIL, orgName: entry.organization ?? FIXTURE_ORGANIZATION, orgId: `${SENTINEL}-org-id`,
    }, 0);
  }
}

function session() {
  const withholdInit = consume('withholdInit');
  const hangUsage = consume('hangUsage');
  const unsupportedUsage = consume('unsupportedUsage');
  const stuck = consume('stuck');
  const malformed = consume('malformed');
  const crash = consume('crashSession');
  const cliRequest = consume('cliRequest');
  record(hangUsage || withholdInit ? 'session-hung' : 'session');
  captureEnv('session');
  const inherited = Object.keys(process.env).map((name) => name.toUpperCase());
  if (SDK_MARKERS.some((name) => inherited.includes(name))) append('sdk-markers', `${process.pid}\n`);
  guardOverlap();
  if (stuck) {
    // Holds no pipe of ours: only a tree kill can reach it. Detached on Windows so the root's
    // kill-on-close job cannot take it down and hide a root-only kill (fake-app-server.mjs).
    spawn(process.execPath, [import.meta.filename, ...(dir ? ['--fixture-dir', dir] : []), 'descendant'], { stdio: 'ignore', windowsHide: true, detached: process.platform === 'win32' });
  }
  if (malformed) process.stdout.write(`${SENTINEL} malformed output ${process.argv.join(' ')}\n`);
  const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const reply = (id, response) => send({ type: 'control_response', response: { subtype: 'success', request_id: id, response } });
  const reject = (id, error) => send({ type: 'control_response', response: { subtype: 'error', request_id: id, error } });
  const reader = createInterface({ input: process.stdin });
  reader.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.type === 'user') { append('prompts', `${process.pid}\n`); return; }
    if (message.type === 'control_response' && message.response?.request_id === `cli-${process.pid}`) {
      if (message.response.subtype === 'success') append('cli-request-accepted', `${process.pid}\n`);
      else write(`cli-request-refused-${process.pid}`, String(message.response.error));
      return;
    }
    if (message.type !== 'control_request') return;
    const { request_id: id, request } = message;
    if (request?.subtype === 'initialize') {
      if (crash) process.exit(3);
      if (withholdInit) { write(`withheld-${process.pid}`, 'withheld'); return; }
      // Asks fat-g for something a real CLI asks an SDK host for; the answer is recorded above.
      if (cliRequest) send({ type: 'control_request', request_id: `cli-${process.pid}`, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: SENTINEL } } });
      reply(id, { commands: [], ...modelsFor(ACCOUNT.entry), account: sessionAccount() });
    } else if (request?.subtype === 'get_usage') {
      if (hangUsage) { write(`hung-${process.pid}`, 'hung'); return; }
      if (unsupportedUsage) { reject(id, 'Unsupported control request subtype: get_usage'); return; }
      // Not traced: what the CLI answers a signed-out folder. fat-g reads the account first and asks no usage of one.
      if (ACCOUNT.kind !== 'as-before' && !signedIn()) { reject(id, 'not signed in'); return; }
      reply(id, usage(readText('usage-shape', 'full'), request.skip_behaviors === true, ACCOUNT.entry?.usage));
    } else {
      reject(id, `Unsupported control request subtype: ${String(request?.subtype)}`);
    }
  });
  reader.on('close', () => {
    if (stuck) { setInterval(() => {}, 1000); return; }
    release();
    process.exit(0);
  });
}

/**
 * A chat session (M16): one process for one session, answered by replaying the captures. It is
 * recorded in the ledger under a role of its own, and its environment is written out as a control
 * session's is, so a test can say what reached it.
 */
function chat(parsed) {
  record('chat');
  captureEnv('chat');
  const inherited = Object.keys(process.env).map((name) => name.toUpperCase());
  if (SDK_MARKERS.some((name) => inherited.includes(name))) append('sdk-markers', `${process.pid}\n`);
  const replay = createChatReplay({
    args, parsed, cwd: process.cwd(), configFolder: CONFIG_FOLDER, dir,
    output: (text, done) => process.stdout.write(text, done),
    takeControl: consume, readControl, mark: (name) => write(name, String(process.pid)),
  });
  if (!replay.start()) return;
  // A replay's fault can have the process end at the first bytes written to it (claude/replay.mjs,
  // `exitAtAnswer`): before the line they begin is whole, so that its writer is refused the rest.
  process.stdin.on('data', () => { if (replay.endsAtInput()) process.exit(3); });
  const reader = createInterface({ input: process.stdin });
  reader.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    replay.handle(message);
  });
  // As the CLI does: it ends when its input closes.
  reader.on('close', () => { replay.inputClosed(); process.exit(0); });
}

function parseSecretaryArgs(list) {
  if (list.length < SECRETARY_ARGS.length + 2 || !SECRETARY_ARGS.every((arg, index) => list[index] === arg)) return null;
  const rest = list.slice(SECRETARY_ARGS.length);
  if (rest[0] !== '--model' || !rest[1]) return null;
  if (rest.length === 2) return { model: rest[1], effort: null };
  return rest.length === 4 && rest[2] === '--effort' && rest[3] ? { model: rest[1], effort: rest[3] } : null;
}

/** A secretary's process (M26): K1's capture replayed, its `initialize` reply under fat-g's id, then the turn at the prompt. */
function secretary(parsed) {
  record('secretary');
  captureEnv('secretary');
  const hang = consume('secretaryHang');
  const empty = consume('secretaryEmpty');
  const ask = consume('secretaryRequest');
  const capture = JSON.parse(readFileSync(path.join(import.meta.dirname, 'claude', 'captures', 'm26-claude-small-model.json'), 'utf8'));
  const received = capture.frames.filter((entry) => entry.dir === 'recv').map((entry) => entry.frame);
  const initialized = received.find((frame) => frame.type === 'control_response');
  const turn = received.filter((frame) => frame !== initialized && !(empty && frame.type === 'assistant'));
  write(`secretary-${process.pid}.json`, JSON.stringify({ ...parsed, cwd: process.cwd() }));
  const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const reader = createInterface({ input: process.stdin });
  reader.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.type === 'user') {
      append('secretary-prompts', `${process.pid}\n`);
      if (hang) { write(`hung-${process.pid}`, 'hung'); return; }
      for (const frame of turn) send(frame);
      return;
    }
    if (message.type === 'control_response' && message.response?.request_id === `cli-${process.pid}`) {
      write(`secretary-request-${message.response.subtype === 'success' ? 'accepted' : 'refused'}-${process.pid}`, String(message.response.error ?? ''));
      return;
    }
    if (message.type !== 'control_request') return;
    const { request_id: id, request } = message;
    if (request?.subtype !== 'initialize') { write('unexpected-secretary-request', String(request?.subtype)); return; }
    const prompt = request.systemPrompt;
    write(`secretary-initialize-${process.pid}.json`, JSON.stringify({ fields: Object.keys(request).sort(), oneSystemPrompt: Array.isArray(prompt) && prompt.length === 1 && typeof prompt[0] === 'string' && prompt[0] !== '' }));
    if (ask) send({ type: 'control_request', request_id: `cli-${process.pid}`, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: SENTINEL } } });
    send({ ...initialized, response: { ...initialized.response, request_id: id } });
  });
  // As the CLI does: it ends when its input closes.
  reader.on('close', () => process.exit(0));
}

/** The `initialize` reply's account: the fixture's, an entry's, or what a signed-out folder showed M14b's spike (no email). */
function sessionAccount() {
  if (ACCOUNT.kind === 'as-before') return { email: FIXTURE_EMAIL, organization: FIXTURE_ORGANIZATION, subscriptionType: 'Claude Max', apiProvider: 'firstParty' };
  if (!signedIn()) return { apiProvider: 'firstParty', tokenSource: 'none' };
  const { email = FIXTURE_EMAIL, organization = FIXTURE_ORGANIZATION, plan = 'max' } = ACCOUNT.entry;
  return { email, organization, subscriptionType: `Claude ${plan[0].toUpperCase()}${plan.slice(1)}`, apiProvider: 'firstParty' };
}

/** `readings`: an account's own used percents, in place of the fixture's 12, 81 and 44. */
function usage(shape, skipBehaviors, readings = {}) {
  const at = (hours) => new Date(Date.now() + hours * 3_600_000).toISOString().replace('Z', '+00:00');
  const percent = { session: 12, weekly: 81, scoped: 44, ...readings };
  const named = {
    five_hour: { utilization: percent.session, resets_at: at(2), limit_dollars: null },
    seven_day: { utilization: percent.weekly, resets_at: at(72), limit_dollars: null },
    seven_day_opus: { utilization: 3, resets_at: at(72) },
    cinder_cove: { utilization: 99, note: SENTINEL },
    tangelo: null,
    model_scoped: [{ display_name: 'Fable', utilization: percent.scoped, resets_at: at(72) }],
    extra_usage: { is_enabled: false, used_credits: 0, currency: SENTINEL },
    spend: { used: { amount_minor: 1234 }, disclaimer: SENTINEL },
  };
  const limits = [
    { kind: 'session', group: 'session', percent: percent.session, severity: 'normal', resets_at: at(2), scope: null, is_active: false },
    { kind: 'weekly_all', group: 'weekly', percent: percent.weekly, severity: 'warning', resets_at: at(72), scope: null, is_active: true },
    { kind: 'weekly_scoped', group: 'weekly', percent: percent.scoped, severity: 'normal', resets_at: at(72), scope: { model: { id: null, display_name: 'Fable' }, surface: null }, is_active: false },
    { kind: `codename_${SENTINEL}`, percent: 1 },
  ];
  const envelope = { subscription_type: 'max', rate_limits_available: true, session: { cost_usd: SENTINEL }, behaviors: skipBehaviors ? null : { note: SENTINEL } };
  switch (shape) {
    case 'named': return { ...envelope, rate_limits: named };
    case 'unavailable': return { ...envelope, rate_limits_available: false, rate_limits: null };
    case 'empty-limits': return { ...envelope, rate_limits: { ...named, limits: [] } };
    // Visual review only: a critical binding window without a reset time and a long model label.
    case 'visual': return { ...envelope, rate_limits: { ...named, limits: [
      limits[0],
      { ...limits[1], percent: 97, severity: 'critical', resets_at: null },
      { ...limits[2], percent: 63, scope: { model: { id: null, display_name: 'Fable 5 Extended Context Preview (Long Display Name)' }, surface: null } },
      { ...limits[2], percent: 0, scope: { model: { id: null, display_name: 'Sonnet' }, surface: null } },
    ] } };
    default: return { ...envelope, rate_limits: { ...named, limits } };
  }
}

/**
 * The lock of this process's account: one a configuration folder (M14b, C54), so two accounts may
 * each run a session while two sessions of one account may not. With the variable unset it is the
 * one lock there always was.
 */
function lockName() {
  return CONFIG_FOLDER === undefined ? 'session.lock' : `session-${createHash('sha256').update(folderKey(CONFIG_FOLDER)).digest('hex').slice(0, 12)}.lock`;
}

/** Two live control sessions of one account at once would be an overlap fat-g promised never to create. */
function guardOverlap() {
  const lock = file(lockName());
  if (!lock) return;
  try {
    const holder = Number(readFileSync(lock, 'utf8'));
    if (Number.isInteger(holder) && holder !== process.pid && alive(holder)) append('overlaps', `${holder} ${process.pid}\n`);
  } catch { /* no live session */ }
  writeFileSync(lock, String(process.pid));
}

function release() {
  const lock = file(lockName());
  try { if (lock && Number(readFileSync(lock, 'utf8')) === process.pid) rmSync(lock); } catch { /* already released */ }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

/** Names of every inherited variable of interest, and values only for the ones tests assert. */
function captureEnv(role) {
  const names = Object.keys(process.env).filter((name) => /^(CLAUDE|ANTHROPIC|DEBUG|NODE_OPTIONS|ELECTRON|HTTPS?_PROXY|FATG_)/i.test(name));
  const values = {};
  for (const name of ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_AGENT_SDK_VERSION', 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS', 'HTTPS_PROXY']) {
    const key = Object.keys(process.env).find((candidate) => candidate.toUpperCase() === name);
    if (key !== undefined) values[name] = process.env[key];
  }
  write(`env-${role}-${process.pid}.json`, JSON.stringify({ names, values }));
}

/** The control file as it stands: the words that stay until it is rewritten. */
function readControl() {
  const control = file('control.json');
  if (!control) return {};
  try {
    const controls = JSON.parse(readFileSync(control, 'utf8'));
    return controls !== null && typeof controls === 'object' ? controls : {};
  } catch {
    return {};
  }
}

function consume(key) {
  const control = file('control.json');
  if (!control) return false;
  try {
    const controls = JSON.parse(readFileSync(control, 'utf8'));
    const remaining = Number(controls[key] ?? 0);
    if (!Number.isInteger(remaining) || remaining <= 0) return false;
    controls[key] = remaining - 1;
    writeFileSync(control, JSON.stringify(controls));
    return true;
  } catch {
    return false;
  }
}

function record(role) { append('pids', `${process.pid} ${role} ${STARTED}\n`); }
function append(name, text) { const target = file(name); if (target) appendFileSync(target, text); }
function write(name, text) { const target = file(name); if (target) writeFileSync(target, text); }
function readText(name, fallback) {
  const target = file(name);
  if (!target) return fallback;
  try { return readFileSync(target, 'utf8').trim() || fallback; } catch { return fallback; }
}
