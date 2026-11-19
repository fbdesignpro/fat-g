// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Fast-mode spike K2: how fat-g asks Codex for its fast speed tier, and how a thread
// reports the tier in force. Codex under M15's runner, in M22's scratch Codex configuration
// (`CODEX_HOME` naming `%USERPROFILE%\.fat-g-spike-m22\codex-home`, signed in by the maintainer);
// the maintainer's own configuration is neither read nor changed.
//
//   node spikes/fast/k2.mjs --list
//   node spikes/fast/k2.mjs --scenario probe --confirm-turns 0 [--again] [--model <id>] [--tier <id>]
//   node spikes/fast/k2.mjs --scenario tier  --confirm-turns 1 [--again] [--model <id>] [--tier <id>] [--own-account]
//
// `--own-account` (the maintainer's word, as M106's K2 took it): their own Codex
// configuration in place of the scratch one — M10's clean environment with the default `CODEX_HOME` —
// the one account that lists a fast tier. Its thread is ephemeral, so nothing is saved to their history.
//
// Without --confirm-turns equal to the scenario's count it prints its plan and launches nothing. One
// invocation is one run; at most three runs per scenario (M10's ledger, under spikes/output/fast).
//
// `probe` (no prompt): the app-server's handshake as fat-g's session makes it (`experimentalApi`, the
// delta opt-outs); `model/list` with `includeHidden`, each row's `serviceTiers`, `defaultServiceTier`
// and `additionalSpeedTiers`; `configRequirements/read`; whether the scratch `config.toml` names
// `service_tier`; then five ephemeral read-only threads started with `serviceTier` omitted, `null`,
// `"default"`, the fast tier's id and an id no model lists — each reply's `serviceTier`. The fast
// tier is the one the model lists named "Fast"; where the account lists none (the scratch account),
// `--tier`, else `priority`, the id the maintainer's own account listed (§5 of the note).
// `tier` (one prompt): the same, then a saved read-only thread started as fat-g starts one with
// `serviceTier` the fast tier's id, ONE short turn as fat-g starts one with `serviceTier` the same id
// on the turn too (the override fat-g sends for a change of speed), `thread/read`, a resume naming
// `serviceTier: null` (no prompt), and what the thread's rollout file in the scratch configuration
// recorded under any key naming a tier or a speed (keys and values, never text). A turn/start
// refused for its tier spends no prompt.
//
// What it writes down: tier ids, names and descriptions, key paths and their scalar values, method
// names and counts, error messages with folders replaced; of the answer, whether it holds the word
// the prompt dictated. Raw captures go to spikes/output/fast/raw/codex/ (git-ignored).
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { CLIENT_INFO } from '../m10/codex/driver.mjs';
import { deltaMethods } from '../m10/codex/frames.mjs';
import { deadlines, sleep } from '../m10/lib/deadlines.mjs';
import { SPIKES_DIR, isMain, writeJson } from '../m10/lib/paths.mjs';
import { log, runSpike, warn } from '../m10/lib/spike.mjs';
import { M15Driver, SANDBOX, didNotHappen, happened, notRun, outline } from '../m15/lib/common.mjs';
import * as m15 from '../m15/lib/common.mjs';
import { CODEX_HOME } from '../m22/k1.mjs';
import { tidy, typeCounts } from '../m22b/lib/common.mjs';
import { CODEX_OPTIONS } from '../m22e/k1.mjs';

export const FAST_DIR = path.join(SPIKES_DIR, 'output', 'fast');
const PROMPT = 'Codex speed-tier check: reply with the single word ready.';
const WORD = 'ready';
const UNKNOWN_TIER = 'fat-g-no-such-tier';
const SCENARIO_MS = 240_000;
const BUDGET_MS = 420_000;

/** fat-g's session handshake (src/main/providers/codex/methods.ts, `sessionHandshake`): the experimental API and the delta opt-outs. */
class FastCodexDriver extends M15Driver {
  async open() {
    await this.startWire();
    this.optedOut = deltaMethods();
    const reply = await this.request('initialize', { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: true, optOutNotificationMethods: this.optedOut } }, 'startup');
    await this.session.send({ method: 'initialized' });
    return reply;
  }
}

const TIERISH = /tier|speed|fast|priority/i;

/** Every key whose name says tier, speed or fast, with its scalar value (or the kind of a non-scalar), by path. */
export function tierKeys(value, at = '', out = [], depth = 0) {
  if (!value || typeof value !== 'object' || depth > 12) return out;
  for (const [key, child] of Object.entries(value)) {
    const here = Array.isArray(value) ? `${at}[${key}]` : at ? `${at}.${key}` : key;
    if (!Array.isArray(value) && TIERISH.test(key)) out.push({ at: here, value: child === null || ['string', 'number', 'boolean'].includes(typeof child) ? child : Array.isArray(child) ? (child.every((c) => c === null || typeof c !== 'object') ? child : `array(${child.length})`) : `object{${Object.keys(child).join(',')}}` });
    tierKeys(child, here, out, depth + 1);
  }
  return out;
}

const folders = (ctx) => ({ 'working folder': ctx.scratch, 'configuration folder': CODEX_HOME, 'app-server folder': ctx.probe });
const errorOf = (reply, ctx) => (reply.ok ? null : { code: reply.error?.code ?? null, message: tidy(String(reply.error?.message ?? ''), folders(ctx), 400) });

/** Each notification received from `from` on whose params name a tier, a speed or fast: its method and those keys. */
function tierNotifications(driver, from) {
  return driver.session.frames.filter((f) => f.dir === 'recv' && f.index >= from && typeof f.frame?.method === 'string' && f.frame.id === undefined)
    .map((f) => ({ index: f.index, method: f.frame.method, keys: tierKeys(f.frame.params) }))
    .filter((row) => row.keys.length > 0);
}

/** What the models list says of speed tiers, per row. */
async function listModels(driver) {
  const reply = await driver.request('model/list', { limit: 100, includeHidden: true });
  const rows = reply.ok && Array.isArray(reply.value?.data) ? reply.value.data : [];
  return {
    ok: reply.ok, rowKeys: [...new Set(rows.flatMap((row) => Object.keys(row)))].sort(),
    rows: rows.map((row) => ({ model: row.model ?? row.id, hidden: row.hidden ?? null, isDefault: row.isDefault ?? null, serviceTiers: row.serviceTiers ?? null, defaultServiceTier: row.defaultServiceTier ?? null, additionalSpeedTiers: row.additionalSpeedTiers ?? null, efforts: (row.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort) })),
  };
}

/**
 * The id the maintainer's own account listed as its one tier, named "Fast", in every capture so far
 * (models-and-effort §5): what a run names when the scratch account lists no tier at all.
 */
const FALLBACK_TIER = 'priority';

/** `--own-account`: the maintainer's own configuration, and an ephemeral thread. */
let OWN = false;

/**
 * The model a run names (`--model`, else the default row listing a tier, else the default row) and
 * its fast tier: the tier named "Fast", else its first; where the row lists none, `--tier` or
 * FALLBACK_TIER, marked as not listed.
 */
function chooseModel(models, wanted, wantedTier) {
  const listsTier = (row) => Array.isArray(row.serviceTiers) && row.serviceTiers.length > 0;
  const row = wanted ? models.rows.find((r) => r.model === wanted) : (models.rows.find((r) => r.isDefault && listsTier(r)) ?? models.rows.find((r) => !r.hidden && listsTier(r)) ?? models.rows.find((r) => r.isDefault));
  if (!row) return null;
  const listed = (row.serviceTiers ?? []).find((t) => (wantedTier ? t.id === wantedTier : /^fast$/i.test(String(t.name ?? '')))) ?? (wantedTier ? null : row.serviceTiers?.[0] ?? null);
  const tier = listed?.id ?? wantedTier ?? FALLBACK_TIER;
  return { model: row.model, tier, tierName: listed?.name ?? null, tierListedForTheModel: Boolean(listed), effort: row.efforts.includes('low') ? 'low' : row.efforts[0] ?? null };
}

/** The scratch `config.toml`: whether it names a service tier (its text is not kept). */
function configNamesTier() {
  const file = path.join(CODEX_HOME, 'config.toml');
  if (!existsSync(file)) return { exists: false };
  const text = readFileSync(file, 'utf8');
  return { exists: true, namesServiceTier: /^\s*service_tier\s*=/m.test(text), tierLines: text.split(/\r?\n/).filter((line) => /tier|fast/i.test(line) && !/^\s*\[/.test(line)) };
}

/** One ephemeral read-only thread per variant of `serviceTier`, no turn: each reply's tier, or its refusal. */
async function probeThreads(ctx, driver, chosen) {
  const variants = [
    ['omitted', {}],
    ['null', { serviceTier: null }],
    ['"default"', { serviceTier: 'default' }],
    [`the fast tier's id ("${chosen.tier}")`, { serviceTier: chosen.tier }],
    [`an id no model lists ("${UNKNOWN_TIER}")`, { serviceTier: UNKNOWN_TIER }],
  ];
  const out = [];
  for (const [label, extra] of variants) {
    const from = driver.nextIndex;
    const params = { cwd: ctx.scratch, ...SANDBOX, model: chosen.model, ephemeral: true, ...extra };
    const reply = await driver.request('thread/start', params);
    await sleep(400);
    out.push({ serviceTierSent: label, ok: reply.ok, error: errorOf(reply, ctx), replyServiceTier: reply.ok ? (reply.value?.serviceTier ?? null) : undefined, replyHasServiceTierKey: reply.ok ? Object.hasOwn(reply.value ?? {}, 'serviceTier') : null, replyModel: reply.ok ? reply.value?.model ?? null : null, replyTierKeys: reply.ok ? tierKeys(reply.value) : null, notifications: tierNotifications(driver, from) });
  }
  return out;
}

/** What the thread's rollout file recorded under a key naming a tier or a speed: per record type, the distinct key paths and values. */
function rolloutTiers(file) {
  if (typeof file !== 'string' || !file) return { file: 'none named' };
  const resolved = path.resolve(file);
  if (!resolved.toLowerCase().startsWith(path.resolve(CODEX_HOME).toLowerCase() + path.sep)) return { file: 'outside the scratch configuration folder: not read' };
  if (!existsSync(resolved)) return { file: 'named, not there' };
  const rows = {};
  let lines = 0;
  for (const line of readFileSync(resolved, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    lines++;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const kind = [record.type, record.payload?.type].filter(Boolean).join('/');
    for (const hit of tierKeys(record)) {
      const key = `${kind} ${hit.at}=${JSON.stringify(hit.value)}`;
      rows[key] = (rows[key] ?? 0) + 1;
    }
  }
  return { file: 'read (inside the scratch configuration folder)', lines, tierKeys: rows };
}

/** One prompt as fat-g starts a turn (codex/session.ts): text input, the model and effort, a message id; and `serviceTier`, the turn-level override fat-g sends for a change of speed. */
async function oneTurn(ctx, driver, chosen) {
  const from = driver.nextIndex;
  const params = { threadId: driver.threadId, input: [{ type: 'text', text: PROMPT, text_elements: [] }], model: chosen.model, ...(chosen.effort ? { effort: chosen.effort } : {}), serviceTier: chosen.tier, clientUserMessageId: randomUUID() };
  const reply = await driver.requestWithin('turn/start', params, 15_000);
  if (!reply.ok) return { refused: true, sent: { serviceTier: chosen.tier }, error: errorOf(reply, ctx), notifications: tierNotifications(driver, from) };
  ctx.countTurn();
  driver.turnId = reply.value?.turn?.id ?? null;
  driver.turnActive = true;
  const end = await ctx.turnEnd(driver, from);
  await sleep(1_500);
  const received = driver.session.frames.filter((f) => f.dir === 'recv' && f.index >= from);
  const messages = received.filter((f) => f.frame?.method === 'item/completed' && f.frame.params?.item?.type === 'agentMessage').map((f) => String(f.frame.params.item.text ?? ''));
  const completed = received.find((f) => f.frame?.method === 'turn/completed' && f.frame.params?.threadId === driver.threadId)?.frame ?? null;
  const started = received.find((f) => f.frame?.method === 'turn/started' && f.frame.params?.threadId === driver.threadId);
  const usage = received.filter((f) => f.frame?.method === 'thread/tokenUsage/updated').at(-1)?.frame?.params ?? null;
  return {
    refused: false, sent: { keys: Object.keys(params).sort(), model: params.model, effort: params.effort ?? null, serviceTier: params.serviceTier },
    turnStartReplyKeys: Object.keys(reply.value ?? {}).sort(), turnStartReplyTierKeys: tierKeys(reply.value),
    end: { status: end.status ?? null, error: completed?.params?.turn?.error ? tidy(String(completed.params.turn.error.message ?? ''), folders(ctx), 300) : null, errorInfo: completed?.params?.turn?.error?.codexErrorInfo ?? null },
    msTurn: started && completed ? Math.round(received.find((f) => f.frame === completed).ms - started.ms) : null,
    turnCompletedKeys: completed ? { params: Object.keys(completed.params ?? {}).sort(), turn: Object.keys(completed.params?.turn ?? {}).sort() } : null,
    turnCompletedTierKeys: completed ? tierKeys(completed.params) : null,
    tokenUsageKeys: usage ? { params: Object.keys(usage).sort(), tokenUsage: Object.keys(usage.tokenUsage ?? {}).sort(), last: usage.tokenUsage?.last ?? null } : null,
    tierNotifications: tierNotifications(driver, from),
    rateLimitNotifications: received.filter((f) => f.frame?.method === 'account/rateLimits/updated').map((f) => ({ index: f.index, keys: Object.keys(f.frame.params?.rateLimits ?? {}).sort(), tierKeys: tierKeys(f.frame.params) })),
    errors: received.filter((f) => f.frame?.method === 'error').map((f) => ({ message: tidy(String(f.frame.params?.error?.message ?? ''), folders(ctx), 300), info: f.frame.params?.error?.codexErrorInfo ?? null, willRetry: f.frame.params?.willRetry ?? null })),
    warnings: received.filter((f) => ['warning', 'configWarning', 'deprecationNotice', 'model/rerouted'].includes(f.frame?.method)).map((f) => ({ method: f.frame.method, keys: Object.keys(f.frame.params ?? {}).sort(), tierKeys: tierKeys(f.frame.params) })),
    answerHoldsTheWord: messages.length ? new RegExp(`\\b${WORD}\\b`, 'i').test(messages.at(-1)) : null,
    agentMessages: messages.length,
  };
}

let WANTED = null;
let WANTED_TIER = null;

async function common(ctx) {
  const driver = await ctx.open();
  const init = driver.session.frames.find((f) => f.dir === 'recv' && f.frame?.id === 1)?.frame?.result ?? null;
  const notes = { handshake: { experimentalApi: true, replyKeys: Object.keys(init ?? {}).sort(), replyTierKeys: tierKeys(init) } };
  notes.models = await listModels(driver);
  const requirements = await driver.request('configRequirements/read', undefined);
  notes.configRequirements = requirements.ok ? { keys: Object.keys(requirements.value ?? {}).sort(), supportsIndependentSpeedModes: requirements.value?.supportsIndependentSpeedModes ?? null, requirementsPresent: requirements.value?.requirements != null, requirementsTierKeys: tierKeys(requirements.value?.requirements) } : { error: errorOf(requirements, ctx) };
  notes.scratchConfigToml = configNamesTier();
  const chosen = chooseModel(notes.models, WANTED, WANTED_TIER);
  notes.chosen = chosen;
  return { driver, notes, chosen };
}

const SCENARIOS = {
  probe: {
    id: 'fast-codex-probe', name: 'fast-codex-probe', turns: 0,
    title: 'K2: model/list tiers, configRequirements, and five ephemeral thread/starts with serviceTier omitted, null, "default", the fast id and an unknown id (no prompt)',
    successCondition: 'model/list answered and each thread/start was answered (taken or refused)',
    async run(ctx) {
      const { driver, notes, chosen } = await common(ctx);
      if (!chosen) return notRun('no model to name', notes);
      notes.threadProbes = await probeThreads(ctx, driver, chosen);
      notes.typeCounts = typeCounts(driver, (frame) => frame?.method ?? 'response');
      writeJson(path.join(FAST_DIR, 'k2-codex-probe.json'), { at: new Date().toISOString(), notes });
      return happened(notes, driver.nextIndex - 1);
    },
  },
  tier: {
    id: 'fast-codex-tier', name: 'fast-codex-tier', turns: 1,
    title: "K2: the probes, then a saved read-only thread started with serviceTier the fast tier's id, ONE short turn naming it too, thread/read, a resume naming null, and the rollout's tier keys",
    successCondition: 'The thread/start with the fast tier is taken, and its turn completes',
    async run(ctx) {
      const { driver, notes, chosen } = await common(ctx);
      if (!chosen) return notRun('no model to name', notes);
      notes.threadProbes = await probeThreads(ctx, driver, chosen);
      const from = driver.nextIndex;
      const thread = await ctx.startThread(driver, { model: chosen.model, serviceTier: chosen.tier, ...(OWN ? { ephemeral: true } : {}) });
      await sleep(400);
      notes.fastThread = { sent: { serviceTier: chosen.tier, model: chosen.model, ephemeral: OWN, ...SANDBOX }, ok: thread.ok, error: errorOf(thread, ctx), replyServiceTier: thread.ok ? thread.value?.serviceTier ?? null : undefined, replyKeys: thread.ok ? Object.keys(thread.value ?? {}).sort() : null, threadKeys: thread.ok ? Object.keys(thread.value?.thread ?? {}).sort() : null, notifications: tierNotifications(driver, from) };
      if (!thread.ok) return didNotHappen('thread/start with the fast tier was refused', notes);
      const rolloutFile = thread.value?.thread?.path ?? null;
      notes.turn = await oneTurn(ctx, driver, chosen);
      if (notes.turn.refused) {
        writeJson(path.join(FAST_DIR, 'k2-codex-tier.json'), { at: new Date().toISOString(), notes });
        return didNotHappen('turn/start was refused (no prompt spent)', notes);
      }
      const read = await driver.request('thread/read', { threadId: driver.threadId, includeTurns: true });
      notes.threadRead = read.ok ? { keys: Object.keys(read.value ?? {}).sort(), threadKeys: Object.keys(read.value?.thread ?? {}).sort(), turnKeys: [...new Set((read.value?.thread?.turns ?? []).flatMap((t) => Object.keys(t)))].sort(), tierKeys: tierKeys(read.value) } : { error: errorOf(read, ctx) };
      // No prompt: the same thread asked back to standard speed by a resume naming null, and what its reply says.
      const resumeFrom = driver.nextIndex;
      const resumed = await driver.requestWithin('thread/resume', { threadId: driver.threadId, serviceTier: null }, 30_000);
      notes.resumeWithNull = { ok: resumed.ok, error: errorOf(resumed, ctx), replyServiceTier: resumed.ok ? resumed.value?.serviceTier ?? null : undefined, notifications: tierNotifications(driver, resumeFrom) };
      await sleep(1_000);
      notes.rollout = rolloutTiers(rolloutFile);
      notes.typeCounts = typeCounts(driver, (frame) => frame?.method ?? 'response');
      notes.outline = outline(driver, from).filter((row) => !['thread/tokenUsage/updated', 'mcpServer/startupStatus/updated', 'item/agentMessage/delta', 'item/reasoning/summaryTextDelta'].includes(row.method));
      writeJson(path.join(FAST_DIR, 'k2-codex-tier.json'), { at: new Date().toISOString(), notes });
      if (notes.turn.end.status !== 'completed') return didNotHappen(`the turn ended ${notes.turn.end.status}`, notes);
      return happened(notes, driver.nextIndex - 1);
    },
  },
};

const OPTIONS = { ...CODEX_OPTIONS, dir: FAST_DIR, milestone: 'fast-mode', Driver: FastCodexDriver };

if (isMain(import.meta.url)) {
  await runSpike('fast-k2', (frame) => {
    if (frame.args.list) {
      for (const [key, scenario] of Object.entries(SCENARIOS)) log(`${key.padEnd(6)} ${scenario.turns} prompt(s)  ${scenario.title}`);
      return 0;
    }
    const chosen = SCENARIOS[String(frame.args.scenario ?? '')];
    if (!chosen) { warn('usage: node spikes/fast/k2.mjs --list | --scenario probe|tier --confirm-turns <0|1> [--again] [--model <id>] [--tier <id>] [--own-account] [--path <executable>]'); return 1; }
    OWN = frame.args['own-account'] === true;
    WANTED = typeof frame.args.model === 'string' ? frame.args.model : null;
    WANTED_TIER = typeof frame.args.tier === 'string' ? frame.args.tier : null;
    const waits = deadlines({ scenario: SCENARIO_MS });
    log(`K2: ${OWN ? "the maintainer's own Codex configuration, at their word, an ephemeral thread" : 'the scratch Codex configuration (CODEX_HOME)'}; ${WANTED ? `the model ${WANTED}` : 'the default model listing a tier'}; fat-g's session handshake`);
    const { environment: _environment, ready: _ready, ...own } = OPTIONS;
    return m15.runScenario('fast-k2', chosen, { ...frame, waits }, OWN ? own : OPTIONS);
  }, { budgetMs: BUDGET_MS });
}
