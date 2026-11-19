// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// B4: what each CLI reports about its models, effort levels and fast mode, without spending a turn
// (C13–C15, Design 5). No prompt frame and no turn/start is ever sent, and the script fails if a
// turn frame arrives anyway (V8). A rejected request is recorded with its exact text.
//
//   node spikes/m10/discover.mjs [--cli claude|codex] [--path <executable>]
import { existsSync, readFileSync } from 'node:fs';
import { ClaudeDriver, CONTROL_ARGS } from './claude/driver.mjs';
import { CodexDriver } from './codex/driver.mjs';
import { buildCapture, saveRaw } from './lib/capture.mjs';
import { EXIT } from './lib/deadlines.mjs';
import { cleanEnvironment } from './lib/env.mjs';
import { resolveExecutable } from './lib/executable.mjs';
import { isMain, outputPath, writeJson } from './lib/paths.mjs';
import { buildScratch } from './lib/scratch.mjs';
import { log, runSpike, warn } from './lib/spike.mjs';
import { CliExited } from './lib/wire.mjs';
import { requireReady } from './preflight.mjs';

export const UNKNOWN_MODEL = 'm10-no-such-model';
const CLAUDE_TURN_TYPES = new Set(['assistant', 'result', 'user', 'system/init', 'stream_event']);
const CODEX_TURN_METHODS = /^(turn\/|item\/)/;

function turnFrames(driver, cli) {
  return driver.session.frames.filter((f) => f.dir === 'recv' && (cli === 'claude' ? CLAUDE_TURN_TYPES.has(driver.table.typeKey(f.frame)) : CODEX_TURN_METHODS.test(f.frame?.method ?? ''))).length;
}

async function claudeSession(ctx, name, extraArgs) {
  const environment = cleanEnvironment('claude');
  const driver = new ClaudeDriver({ launcher: ctx.launcher, executable: ctx.executable, args: [...CONTROL_ARGS, ...extraArgs], cwd: ctx.dir, env: environment.env, waits: ctx.waits, signal: ctx.signal });
  const out = { name, launchArgs: extraArgs, started: false, replies: {} };
  try {
    let init;
    try { init = await driver.open(); } catch (error) {
      if (!(error instanceof CliExited)) throw error;
      out.startFailure = { stage: 'launch', exitCode: error.info?.code ?? null, stderr: driver.tree?.stderrTail ?? '' };
      return out;
    }
    out.started = init.ok;
    out.replies.initialize = init.ok ? { models: init.value?.models ?? null, fast_mode_state: init.value?.fast_mode_state ?? null, fast_mode_disabled_reason: init.value?.fast_mode_disabled_reason ?? null, keys: Object.keys(init.value ?? {}).sort() } : { error: init.error };
    if (!init.ok) return out;
    for (const [subtype, payload] of [['get_settings', {}], ['get_context_usage', { detail: 'summary' }], ['mcp_status', {}]]) {
      const reply = await driver.request(subtype, payload);
      out.replies[subtype] = reply.ok ? summarizeClaude(subtype, reply.value) : { error: reply.error };
    }
  } finally {
    const cleanup = await driver.close();
    out.turnFrames = turnFrames(driver, 'claude');
    out.cleanupConfirmed = cleanup.confirmed;
    const capture = buildCapture({ spike: 'discover.mjs', cli: ctx.cliInfo, scenario: { id: `discovery-${name}`, title: `Claude discovery, ${name}`, successCondition: 'Replies to initialize, get_settings, get_context_usage and mcp_status; no turn frame' }, driver, environment, waits: ctx.waits,
      run: { outcome: out.started ? 'happened' : 'did-not-happen', turnsSpent: 0, turnFrames: out.turnFrames, cleanup: { confirmed: cleanup.confirmed, graceful: cleanup.graceful, forced: cleanup.forced } },
      sessionStart: { request: { subtype: 'initialize' } }, toolPermissions: { note: 'idle session, the app\'s own usage-session arguments; no prompt' } });
    saveRaw('claude', `discovery-${name}`, capture);
  }
  return out;
}

/** What discovery keeps from a reply: the parts that answer C15, not the whole settings document. */
function summarizeClaude(subtype, value) {
  if (subtype === 'get_settings') return { applied: value?.applied ?? null, effectiveKeys: Object.keys(value?.effective ?? {}).sort(), sources: Array.isArray(value?.sources) ? value.sources.map((s) => s?.source ?? s?.name ?? '?') : null, keys: Object.keys(value ?? {}).sort() };
  if (subtype === 'get_context_usage') return { model: value?.model ?? null, maxTokens: value?.maxTokens ?? null, systemTools: (value?.systemTools ?? []).map((t) => t.name), deferredBuiltinTools: (value?.deferredBuiltinTools ?? []).map((t) => t.name), mcpToolCount: (value?.mcpTools ?? []).length, agentCount: (value?.agents ?? []).length, skillCount: value?.skills?.totalSkills ?? null, memoryFileCount: (value?.memoryFiles ?? []).length };
  if (subtype === 'mcp_status') return { serverCount: Array.isArray(value?.mcpServers) ? value.mcpServers.length : null };
  return value;
}

async function claudeDiscovery(ctx) {
  const idle = await claudeSession(ctx, 'idle', []);
  const models = idle.replies.initialize?.models ?? [];
  const applied = idle.replies.get_settings?.applied ?? {};
  const pickModel = models.find((m) => /haiku/i.test(m.value) && m.value !== applied.model) ?? models.find((m) => m.value !== applied.model && m.value !== 'default');
  const current = models.find((m) => m.value === applied.model) ?? models.find((m) => m.value === 'default') ?? models[0];
  const levels = current?.supportedEffortLevels ?? [];
  const lowerEffort = levels.includes('low') && applied.effort !== 'low' ? 'low' : levels.find((l) => l !== applied.effort) ?? null;
  // The second session is launched with a model and an effort, so it needs a model that has
  // effort levels and is not the one already in force.
  const launchModel = models.find((m) => m.value !== 'default' && m.resolvedModel !== applied.model && m.supportedEffortLevels?.length) ?? pickModel;
  const launchedEffort = launchModel?.supportedEffortLevels?.includes('low') ? 'low' : launchModel?.supportedEffortLevels?.[0];
  const flagArgs = launchModel ? ['--model', launchModel.value, ...(ctx.flags?.['--effort'] && launchedEffort ? ['--effort', launchedEffort] : [])] : [];
  const launched = launchModel ? await claudeSession(ctx, 'launched-with-model', flagArgs) : null;
  const unknown = await claudeSession(ctx, 'unknown-model', ['--model', UNKNOWN_MODEL]);
  return {
    sessions: [idle, launched, unknown].filter(Boolean),
    summary: {
      models: models.map((m) => ({ value: m.value, resolvedModel: m.resolvedModel ?? null, displayName: m.displayName, supportsEffort: m.supportsEffort ?? null, supportedEffortLevels: m.supportedEffortLevels ?? null, supportsFastMode: m.supportsFastMode ?? null, supportsAdaptiveThinking: m.supportsAdaptiveThinking ?? null, supportsAutoMode: m.supportsAutoMode ?? null, fields: Object.keys(m).sort() })),
      applied, fastMode: { state: idle.replies.initialize?.fast_mode_state ?? null, disabledReason: idle.replies.initialize?.fast_mode_disabled_reason ?? null },
      launchedWith: launched ? { args: flagArgs, applied: launched.replies.get_settings?.applied ?? null, contextModel: launched.replies.get_context_usage?.model ?? null } : null,
      unknownModel: { started: unknown.started, startFailure: unknown.startFailure ?? null, applied: unknown.replies.get_settings?.applied ?? null },
      lowerEffort, modelB: pickModel?.value ?? null,
      turnFrames: [idle, launched, unknown].filter(Boolean).reduce((n, s) => n + (s.turnFrames ?? 0), 0),
    },
  };
}

async function codexDiscovery(ctx) {
  const environment = cleanEnvironment('codex');
  const driver = new CodexDriver({ launcher: ctx.launcher, executable: ctx.executable, cwd: ctx.dir, env: environment.env, waits: ctx.waits, signal: ctx.signal });
  const out = { replies: {} };
  try {
    const init = await driver.open();
    out.replies.initialize = init.ok ? { keys: Object.keys(init.value ?? {}).sort() } : { error: init.error };
    const models = [];
    let cursor = null;
    for (let page = 0; page < 5; page++) {
      const reply = await driver.request('model/list', { ...(cursor ? { cursor } : {}), includeHidden: true });
      if (!reply.ok) { out.replies.modelList = { error: reply.error }; break; }
      models.push(...(reply.value?.data ?? []));
      cursor = reply.value?.nextCursor ?? null;
      if (!cursor) break;
    }
    out.models = models;
    const config = await driver.request('config/read', { includeLayers: false });
    out.replies.configRead = config.ok ? config.value : { error: config.error };
  } finally {
    const cleanup = await driver.close();
    out.turnFrames = turnFrames(driver, 'codex');
    const capture = buildCapture({ spike: 'discover.mjs', cli: ctx.cliInfo, scenario: { id: 'discovery', title: 'Codex discovery', successCondition: 'Replies to initialize, model/list and config/read (reduced); no turn frame' }, driver, environment, waits: ctx.waits,
      run: { outcome: out.models ? 'happened' : 'did-not-happen', turnsSpent: 0, turnFrames: out.turnFrames, cleanup: { confirmed: cleanup.confirmed, graceful: cleanup.graceful, forced: cleanup.forced } },
      sessionStart: null, toolPermissions: { note: 'no thread, no turn' } });
    saveRaw('codex', 'discovery', capture);
  }
  const models = out.models ?? [];
  const byEffort = (m) => (m.supportedReasoningEfforts ?? []).map((e) => (typeof e === 'string' ? e : e?.reasoningEffort ?? e?.effort)).filter(Boolean);
  const def = models.find((m) => m.isDefault) ?? models[0];
  const levels = def ? byEffort(def) : [];
  const defaultEffort = def?.defaultReasoningEffort ?? null;
  const other = models.find((m) => m !== def && !m.hidden && /mini/i.test(m.id ?? m.model ?? '')) ?? models.find((m) => m !== def && !m.hidden);
  return {
    replies: out.replies,
    summary: {
      models: models.map((m) => ({ id: m.id ?? null, model: m.model ?? null, displayName: m.displayName ?? null, isDefault: m.isDefault ?? null, hidden: m.hidden ?? null, defaultReasoningEffort: m.defaultReasoningEffort ?? null, supportedReasoningEfforts: byEffort(m), fields: Object.keys(m).sort() })),
      defaultModel: def?.id ?? def?.model ?? null, defaultEffort,
      lowerEffort: levels.includes('low') && defaultEffort !== 'low' ? 'low' : levels.find((l) => l !== defaultEffort) ?? null,
      modelB: other?.id ?? other?.model ?? null,
      configRead: out.replies.configRead,
      turnFrames: out.turnFrames,
    },
  };
}

async function discover({ args, launcher, signal, waits }) {
  const which = args.cli ? [args.cli] : ['codex', 'claude'];
  let failed = false;
  for (const cli of which) {
    const executable = resolveExecutable(cli, which.length === 1 ? args.path : undefined);
    const { dir } = buildScratch('probe');
    const cliInfo = await requireReady(launcher, waits, cli, executable, dir);
    const preflight = existsSync(outputPath('preflight.json')) ? JSON.parse(readFileSync(outputPath('preflight.json'), 'utf8')) : null;
    const ctx = { launcher, waits, signal, executable, cliInfo, dir, flags: preflight?.claude?.flags ?? null };
    const result = cli === 'claude' ? await claudeDiscovery(ctx) : await codexDiscovery(ctx);
    writeJson(outputPath(`discovery-${cli}.json`), { date: new Date().toISOString(), version: cliInfo.version, ...result });
    log(`${cli} ${cliInfo.version}: ${JSON.stringify(result.summary, null, 2)}`);
    if (result.summary.turnFrames > 0) { warn(`${cli}: ${result.summary.turnFrames} turn frame(s) arrived during discovery (V8 fails)`); failed = true; }
  }
  return failed ? EXIT.error : EXIT.happened;
}

if (isMain(import.meta.url)) await runSpike('discover', discover);
