// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Fast-mode spike K1: how fat-g asks Claude Code for fast mode, how a session reports
// it, what the idle session can learn of an account's block, and whether anything is written to a
// settings file. Claude under the app's chat launch (src/main/providers/claude/chat-launch.ts:
// `chatFixedArgs` under the reading mode, `--model`, `--effort`, the one variable the launch adds),
// in M14b's scratch configuration folder (`CLAUDE_CONFIG_DIR` naming
// `%TEMP%\fat-g-spike-m14b\claude-login`); the maintainer's own configuration is neither read nor
// changed. Plain Node on M10's launcher, deadlines, process-tree check and driver.
//
//   node spikes/fast/k1.mjs --part idle [--model <row value>] [--effort <level>]
//   node spikes/fast/k1.mjs --part prompt --confirm-turns 1 [--again] [--model <row value>] [--effort <level>]
//
// `idle` (no prompt; runs signed out too): (a) one launch, `initialize` — its `fast_mode_state`,
// `fast_mode_disabled_reason` and each model row's `supportsFastMode`; `get_settings`; then
// `apply_flag_settings` with `fastMode` true, false and null in turn, each followed by
// `get_settings`, every reply and every frame between them searched for a key naming fast, speed,
// tier, overage or cooldown. (d) A second launch with `--settings {"fastMode":true}` added:
// `initialize` and `get_settings` only. (e) The scratch folder's settings-type files (size, time,
// sha256; a credentials file by its size and time alone, never opened) before and after.
//
// `prompt` (ONE prompt; needs the scratch folder signed in, which only the maintainer can do: with
// `$env:CLAUDE_CONFIG_DIR` naming the folder, `claude auth login` in their own terminal): (b) one
// launch, `initialize`, `apply_flag_settings {fastMode:true}`, `get_settings`, one short prompt, and
// from its frames every key naming fast/speed/tier/overage/cooldown with its scalar value, the
// `result`'s `usage` and `modelUsage` (keys and numbers), `rate_limit_event` fields; (c) then
// `apply_flag_settings {fastMode:false}` and `get_settings`, no prompt. The settings files likewise.
// Without --confirm-turns 1 it prints its plan and launches nothing; at most three runs (M10's ledger
// under spikes/output/fast), so two retries for a transient failure (`--again`).
//
// What it writes down: booleans, states, reasons, key paths and their scalar values, model ids and
// numbers. Of the model's answer, only whether it holds the word the prompt dictated. Raw frames go
// to spikes/output/fast/raw/claude/ (git-ignored) with every text of the model's replaced by its length.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { M16Driver, CONFIG_DIR, chatEnvironment } from '../m16/lib/common.mjs';
import { typeKey } from '../m10/claude/frames.mjs';
import { DeadlineExpired, EXIT, deadlines, settlesWithin, sleep } from '../m10/lib/deadlines.mjs';
import { resolveExecutable } from '../m10/lib/executable.mjs';
import { Ledger } from '../m10/lib/ledger.mjs';
import { isMain, writeJson } from '../m10/lib/paths.mjs';
import { buildScratch } from '../m10/lib/scratch.mjs';
import { log, runSpike, warn } from '../m10/lib/spike.mjs';
import { claudeLoggedIn, parseVersion } from '../m10/preflight.mjs';
import { FAST_DIR } from './k2.mjs';

const PROMPT = 'Claude fast-mode check: reply with the single word ready.';
const WORD = 'ready';
const DEFAULT_MODEL = 'opus[1m]';
const DEFAULT_EFFORT = 'low';
const SCENARIO_MS = 240_000;
const BUDGET_MS = 420_000;

/** The reading mode's launch (chat-modes.ts, chat-launch.ts `chatFixedArgs`), then the record's model and effort. */
export function chatLaunchArgs({ model, effort, extra = [] }) {
  return [
    '--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json',
    '--setting-sources', 'user,project,local',
    '--permission-mode', 'default', '--permission-prompt-tool', 'stdio',
    '--tools', 'Read,Glob,Grep,Agent,AskUserQuestion',
    '--include-partial-messages',
    '--model', model, ...(effort ? ['--effort', effort] : []),
    ...extra,
  ];
}

const FASTISH = /fast|speed|tier|overage|cooldown/i;

/** Every key naming fast, speed, tier, overage or cooldown, with its scalar value (or the kind of a non-scalar), by path. */
export function fastKeys(value, at = '', out = [], depth = 0) {
  if (!value || typeof value !== 'object' || depth > 12) return out;
  for (const [key, child] of Object.entries(value)) {
    const here = Array.isArray(value) ? `${at}[${key}]` : at ? `${at}.${key}` : key;
    if (!Array.isArray(value) && FASTISH.test(key)) out.push({ at: here, value: child === null || ['string', 'number', 'boolean'].includes(typeof child) ? child : Array.isArray(child) ? `array(${child.length})` : `object{${Object.keys(child).join(',')}}` });
    fastKeys(child, here, out, depth + 1);
  }
  return out;
}

/** Scalars of an object, one level down too: usage and modelUsage carry numbers and short ids, no text. */
function scalars(value, depth = 0) {
  if (value === null || typeof value !== 'object') return typeof value === 'string' ? value.slice(0, 80) : value;
  if (Array.isArray(value)) return `array(${value.length})`;
  if (depth >= 3) return `object{${Object.keys(value).join(',')}}`;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, scalars(child, depth + 1)]));
}

// ── The scratch folder's settings-type files (e) ────────────────────────────────────────────────

const SETTINGS_LIKE = /^(settings.*\.json|\.claude\.json.*|.*\.json)$/i;
const CREDENTIALS = /credential/i;

/** Top-level files of the scratch configuration folder: size, time and sha256 of the settings-type ones; a credentials file by its size and time alone. */
function folderFiles() {
  if (!existsSync(CONFIG_DIR)) return { exists: false };
  const files = {};
  for (const entry of readdirSync(CONFIG_DIR, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(CONFIG_DIR, entry.name);
    const stat = statSync(file);
    const row = { bytes: stat.size, mtime: stat.mtime.toISOString() };
    if (!CREDENTIALS.test(entry.name) && SETTINGS_LIKE.test(entry.name)) {
      const bytes = readFileSync(file);
      row.sha256 = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
      try {
        const parsed = JSON.parse(bytes.toString('utf8'));
        if (/^settings/i.test(entry.name)) row.keys = Object.keys(parsed ?? {}).sort();
        else row.fastKeys = fastKeys(parsed).filter((hit) => !/cache|tip|count|seen/i.test(hit.at)).slice(0, 30);
      } catch { row.json = false; }
    } else if (CREDENTIALS.test(entry.name)) row.note = 'a credentials file: never opened';
    files[entry.name] = row;
  }
  return { exists: true, files };
}

function compareFiles(before, after) {
  const names = [...new Set([...Object.keys(before.files ?? {}), ...Object.keys(after.files ?? {})])].sort();
  return names.map((name) => {
    const a = before.files?.[name];
    const b = after.files?.[name];
    const status = !a ? 'added' : !b ? 'removed' : a.sha256 !== b.sha256 || a.bytes !== b.bytes || a.mtime !== b.mtime ? 'changed' : 'unchanged';
    return { name, status, ...(status === 'unchanged' ? {} : { before: a ?? null, after: b ?? null }) };
  });
}

// ── Launch and requests ─────────────────────────────────────────────────────────────────────────

async function runOnce(launcher, executable, args, { cwd, waits, env }) {
  const tree = await launcher.launch({ executable, args, cwd, env });
  let stdout = '';
  if (tree.child) { tree.stdout.setEncoding('utf8'); tree.stdout.on('data', (chunk) => { if (stdout.length < 100_000) stdout += chunk; }); tree.stdin.end(); }
  await settlesWithin(tree.closed, waits.request);
  const code = tree.exitInfo?.code ?? null;
  await tree.teardown();
  return { code, stdout };
}

async function readiness(launcher, waits, executable, cwd) {
  const { env } = chatEnvironment({ background: false });
  const version = parseVersion((await runOnce(launcher, executable, ['--version'], { cwd, waits, env })).stdout);
  const loggedIn = claudeLoggedIn(await runOnce(launcher, executable, ['auth', 'status'], { cwd, waits, env }));
  return { version, loggedIn, kind: executable.kind };
}

/** One launch as the app's: the clean environment with `CLAUDE_CONFIG_DIR` and the background-tasks variable (chat-launch.ts `CHAT_ENVIRONMENT`). */
async function launch(ctx, { label, model, effort, extra = [] }) {
  const environment = chatEnvironment({ background: false });
  const driver = new M16Driver({ launcher: ctx.launcher, executable: ctx.executable, args: chatLaunchArgs({ model, effort, extra }), cwd: ctx.cwd, env: environment.env, waits: ctx.waits, signal: ctx.signal });
  driver.label = label;
  driver.environmentSet = environment.set;
  driver.onRequest(() => ({ decision: 'deny', message: 'This action is not available in this session.' }));
  ctx.drivers.push(driver);
  const reply = await driver.open();
  return { driver, reply };
}

/** What the `initialize` reply says of fast mode, and the model rows' `supportsFastMode`. */
function initializeFacts(reply) {
  if (!reply.ok) return { ok: false, error: String(reply.error).slice(0, 300) };
  const value = reply.value ?? {};
  return {
    ok: true, keys: Object.keys(value).sort(),
    fast_mode_state: value.fast_mode_state ?? '(absent)', fast_mode_disabled_reason: value.fast_mode_disabled_reason ?? '(absent)',
    accountKeys: value.account && typeof value.account === 'object' ? Object.keys(value.account).sort() : null,
    models: Array.isArray(value.models) ? value.models.map((row) => ({ value: row.value, resolvedModel: row.resolvedModel ?? null, supportsFastMode: row.supportsFastMode ?? '(absent)', fastKeys: fastKeys(row) })) : null,
    otherFastKeys: fastKeys(Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'models'))),
  };
}

/** A control request, its reply, and every frame received after it up to the reply and for `settleMs` more. */
async function ask(driver, subtype, payload = {}, settleMs = 600) {
  const from = driver.nextIndex;
  const reply = await driver.request(subtype, payload);
  await sleep(settleMs);
  const between = driver.session.frames.filter((f) => f.dir === 'recv' && f.index >= from && f.index !== reply.index);
  return {
    sent: { subtype, ...payload },
    ok: reply.ok, error: reply.ok ? null : String(reply.error).slice(0, 300),
    replyKeys: reply.ok && reply.value && typeof reply.value === 'object' ? Object.keys(reply.value).sort() : null,
    replyFastKeys: reply.ok ? fastKeys(reply.value) : null,
    applied: subtype === 'get_settings' && reply.ok ? reply.value?.applied ?? null : undefined,
    otherFrames: between.map((f) => ({ index: f.index, type: typeKey(f.frame), fastKeys: fastKeys(f.frame) })),
  };
}

/** A copy of the frames with every text of the model's replaced by its length (the raw file stays git-ignored besides). */
function withoutText(frames) {
  const strip = (value, key = null) => {
    if (typeof value === 'string') return ['text', 'thinking', 'result', 'partial_json', 'signature'].includes(key) ? `<${value.length} units>` : value;
    if (Array.isArray(value)) return value.map((item) => strip(item, key));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'account' ? (v && typeof v === 'object' ? `<keys ${Object.keys(v).join(',')}>` : v) : strip(v, k)]));
    return value;
  };
  return frames.map((f) => ({ index: f.index, dir: f.dir, ms: Math.round(f.ms ?? 0), frame: strip(f.frame) }));
}

async function closeAll(ctx) {
  const out = [];
  for (const driver of ctx.drivers) {
    const cleanup = driver.cleanupState ?? await driver.close();
    driver.cleanupState = cleanup;
    out.push({ label: driver.label, confirmed: cleanup.confirmed, graceful: cleanup.graceful, ms: cleanup.ms });
    if (driver.session.recorder) writeJson(path.join(FAST_DIR, 'raw', 'claude', `${ctx.part}-${driver.label}.json`), { at: new Date().toISOString(), args: driver.args, environmentSet: driver.environmentSet, frames: withoutText(driver.session.frames) });
  }
  return out;
}

async function close(driver) { driver.cleanupState = await driver.close(); return driver.cleanupState; }

// ── The two parts ───────────────────────────────────────────────────────────────────────────────

async function idlePart(ctx) {
  const notes = { part: 'idle', model: ctx.model, effort: ctx.effort, prompts: 0 };
  notes.filesBefore = folderFiles();
  notes.ready = await readiness(ctx.launcher, ctx.waits, ctx.executable, ctx.cwd);

  // (a)–(c) without a prompt: the flag on, off and cleared, each read back.
  const a = await launch(ctx, { label: 'flags', model: ctx.model, effort: ctx.effort });
  notes.initialize = initializeFacts(a.reply);
  notes.steps = [];
  notes.steps.push(await ask(a.driver, 'get_settings'));
  notes.steps.push(await ask(a.driver, 'apply_flag_settings', { settings: { fastMode: true } }));
  notes.steps.push(await ask(a.driver, 'get_settings'));
  notes.steps.push(await ask(a.driver, 'apply_flag_settings', { settings: { fastMode: false } }));
  notes.steps.push(await ask(a.driver, 'get_settings'));
  notes.steps.push(await ask(a.driver, 'apply_flag_settings', { settings: { fastMode: null } }));
  notes.steps.push(await ask(a.driver, 'get_settings'));
  notes.flagsCleanup = await close(a.driver);

  // (d) The flag at launch, by `--settings`: initialize and get_settings only.
  const d = await launch(ctx, { label: 'settings-flag', model: ctx.model, effort: ctx.effort, extra: ['--settings', JSON.stringify({ fastMode: true })] });
  notes.withSettingsFlag = { argument: ['--settings', JSON.stringify({ fastMode: true })], initialize: initializeFacts(d.reply), getSettings: d.reply.ok ? await ask(d.driver, 'get_settings') : null };
  notes.settingsFlagCleanup = await close(d.driver);

  notes.filesAfter = folderFiles();
  notes.filesCompared = compareFiles(notes.filesBefore, notes.filesAfter);
  return { code: EXIT.happened, notes };
}

async function promptPart(ctx) {
  const notes = { part: 'prompt', model: ctx.model, effort: ctx.effort };
  notes.filesBefore = folderFiles();
  notes.ready = await readiness(ctx.launcher, ctx.waits, ctx.executable, ctx.cwd);
  if (!notes.ready.loggedIn) {
    warn('the scratch configuration folder is not signed in. Only the maintainer can sign in: in their own terminal, $env:CLAUDE_CONFIG_DIR = "<that folder>"; claude auth login. No prompt was sent.');
    return { code: EXIT.cliMissing, notes, notRun: true };
  }
  const ledger = new Ledger(path.join(FAST_DIR, 'ledger.json'));
  const run = ledger.open('claude', 'fast-claude-prompt', { again: Boolean(ctx.args.again) });
  notes.run = { id: run.id, number: run.number };
  let status = 'void';
  try {
    const b = await launch(ctx, { label: 'prompt', model: ctx.model, effort: ctx.effort });
    notes.initialize = initializeFacts(b.reply);
    notes.on = await ask(b.driver, 'apply_flag_settings', { settings: { fastMode: true } });
    notes.settingsOn = await ask(b.driver, 'get_settings');
    const from = b.driver.nextIndex;
    ledger.countTurn(run);
    await b.driver.prompt(PROMPT);
    const end = await b.driver.waitEvent((e) => e.kind === 'turn-end', { wait: 'scenario', ms: SCENARIO_MS, from });
    await sleep(1_500);
    const frames = b.driver.session.frames.filter((f) => f.dir === 'recv' && f.index >= from);
    const ofType = (type) => frames.filter((f) => typeKey(f.frame) === type);
    const init = ofType('system/init')[0]?.frame ?? null;
    const result = frames.find((f) => f.index === end.index)?.frame ?? null;
    const own = ofType('assistant').filter((f) => f.frame.parent_tool_use_id == null);
    const text = own.flatMap((f) => (Array.isArray(f.frame.message?.content) ? f.frame.message.content : []).filter((block) => block?.type === 'text').map((block) => String(block.text ?? ''))).join('\n');
    notes.turn = {
      end: { status: end.status, isError: end.isError ?? null, terminal: end.terminalReason ?? null },
      init: init ? { model: init.model ?? null, keys: Object.keys(init).sort(), fastKeys: fastKeys(init) } : null,
      result: result ? { subtype: result.subtype ?? null, isError: result.is_error === true, keys: Object.keys(result).sort(), fast_mode_state: result.fast_mode_state ?? '(absent)', fast_mode_disabled_reason: result.fast_mode_disabled_reason ?? '(absent)', usage: scalars(result.usage ?? null), modelUsage: scalars(result.modelUsage ?? null), fastKeys: fastKeys(result), durationMs: result.duration_ms ?? null, durationApiMs: result.duration_api_ms ?? null } : null,
      assistantUsage: own.map((f) => ({ index: f.index, model: f.frame.message?.model ?? null, usage: scalars(f.frame.message?.usage ?? null), error: f.frame.error ?? null })),
      messageStart: ofType('stream_event').filter((f) => f.frame.event?.type === 'message_start').map((f) => ({ index: f.index, model: f.frame.event.message?.model ?? null, usage: scalars(f.frame.event.message?.usage ?? null) })),
      rateLimitEvents: ofType('rate_limit_event').map((f) => ({ index: f.index, info: scalars(f.frame.rate_limit_info ?? null), keys: Object.keys(f.frame).sort() })),
      systemFrames: frames.filter((f) => typeKey(f.frame).startsWith('system/') && typeKey(f.frame) !== 'system/init').map((f) => ({ index: f.index, type: typeKey(f.frame), keys: Object.keys(f.frame).sort(), fastKeys: fastKeys(f.frame) })),
      everyFastKey: frames.flatMap((f) => fastKeys(f.frame).map((hit) => ({ index: f.index, type: typeKey(f.frame), ...hit }))).filter((hit) => hit.type !== 'stream_event' || !/^event\.delta/.test(hit.at)),
      typeCounts: frames.reduce((counts, f) => { const key = typeKey(f.frame); counts[key] = (counts[key] ?? 0) + 1; return counts; }, {}),
      answerHoldsTheWord: text ? new RegExp(`\\b${WORD}\\b`, 'i').test(text) : null,
    };
    notes.off = await ask(b.driver, 'apply_flag_settings', { settings: { fastMode: false } });
    notes.settingsOff = await ask(b.driver, 'get_settings');
    await close(b.driver);
    status = notes.turn.end.isError ? 'did-not-happen' : 'happened';
  } catch (error) {
    status = error instanceof DeadlineExpired ? 'timed-out' : 'void';
    notes.defect = String(error?.stack ?? error).split('\n').slice(0, 3).join(' | ');
  } finally {
    notes.filesAfter = folderFiles();
    notes.filesCompared = compareFiles(notes.filesBefore, notes.filesAfter);
    ledger.close(run, { status, notes: { model: ctx.model, answerHoldsTheWord: notes.turn?.answerHoldsTheWord ?? null } });
    notes.run.status = status;
    notes.run.turns = run.turns;
  }
  return { code: status === 'happened' ? EXIT.happened : status === 'timed-out' ? EXIT.timedOut : status === 'void' ? EXIT.void : EXIT.didNotHappen, notes };
}

if (isMain(import.meta.url)) {
  await runSpike('fast-k1', async ({ args, launcher, signal }) => {
    const part = String(args.part ?? '');
    if (!['idle', 'prompt'].includes(part)) { warn('usage: node spikes/fast/k1.mjs --part idle | --part prompt --confirm-turns 1 [--again] [--model <row value>] [--effort <level>] [--path <executable>]'); return 1; }
    const model = typeof args.model === 'string' ? args.model : DEFAULT_MODEL;
    const effort = typeof args.effort === 'string' ? args.effort : DEFAULT_EFFORT;
    log(`K1 ${part}: the app's chat launch under the reading mode, --model ${model} --effort ${effort}, the scratch configuration folder; ${part === 'idle' ? 'no prompt' : 'ONE prompt'}`);
    if (part === 'prompt' && String(args['confirm-turns']) !== '1') { log('nothing launched. Re-run with --confirm-turns 1 to spend one prompt.'); return EXIT.happened; }
    if (!existsSync(CONFIG_DIR) || !existsSync(path.join(path.dirname(CONFIG_DIR), '.fat-g-spike'))) { warn('the scratch configuration folder or the marker beside it is missing (spikes/m14b/lib/folders.mjs MARKER_TEXT restores the marker)'); return EXIT.cliMissing; }
    const waits = deadlines({ startup: 60_000, scenario: SCENARIO_MS });
    const ctx = { args, part, model, effort, launcher, signal, waits, executable: resolveExecutable('claude', args.path), cwd: buildScratch('probe').dir, drivers: [] };
    let outcome;
    try {
      outcome = part === 'idle' ? await idlePart(ctx) : await promptPart(ctx);
    } catch (error) {
      outcome = { code: error instanceof DeadlineExpired ? EXIT.timedOut : EXIT.void, notes: { part, defect: String(error?.stack ?? error).split('\n').slice(0, 3).join(' | ') } };
    }
    outcome.notes.cleanup = await closeAll(ctx);
    const file = writeJson(path.join(FAST_DIR, `k1-claude-${part}.json`), { at: new Date().toISOString(), cli: 'claude', ...outcome.notes });
    log(`written: ${path.relative(process.cwd(), file)}; cleanup ${outcome.notes.cleanup.every((c) => c.confirmed) ? 'confirmed' : 'NOT confirmed'}`);
    return outcome.code;
  }, { budgetMs: BUDGET_MS });
}
