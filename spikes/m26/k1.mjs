// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// M26 spike K1 (docs/planning/_archive/M26.md, Spike): the secretary's one-shot title request on Claude, in
// M16's scratch configuration folder. A process with no settings of the user's, no MCP server, no
// tool, no thinking and no transcript; `initialize` carries the title task's instruction as its system prompt,
// then one user message. Two prompts in all, one per scenario.
//
//   node spikes/m26/k1.mjs --list
//   node spikes/m26/k1.mjs --scenario session-model|small-model --confirm-turns 1 [--again]
//
// Without --confirm-turns 1 it prints its plan and launches nothing. One invocation is one run; at
// most three runs per scenario (M10's ledger, under spikes/output/m26). `session-model` names the
// model M16's traces name, at its lowest effort; `small-model` names `haiku`, with no effort.
// `--thinking disabled` (the SDK's own flag for a disabled thinking configuration, absent from
// `--help`) was added after `small-model`'s first run, where `haiku` with no effort thought for 772
// tokens; `session-model`'s one run was made without it.
//
// What a run records is never a text of the model's: the reply's shape, the `init` frame's tools,
// MCP servers and model, the `result` frame's usage, and whether a transcript of the session exists
// anywhere under the configuration folder's `projects/` afterwards.
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { typeKey } from '../m10/claude/frames.mjs';
import { sleep } from '../m10/lib/deadlines.mjs';
import { isMain } from '../m10/lib/paths.mjs';
import { log, runSpike, warn } from '../m10/lib/spike.mjs';
import { CONFIG_DIR, M16Driver, framesOf, happened, initOf, outline, ownText, resultOf, runScenario } from '../m16/lib/common.mjs';
import { FIRST_PROMPT, INSTRUCTIONS, M26_DIR, input, replyFacts } from './lib/common.mjs';

/** The secretary's fixed arguments (M26, Design 2), the model and effort last. */
export function secretaryArgs({ model, effort }) {
  const args = ['--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json', '--setting-sources=', '--strict-mcp-config', '--no-session-persistence', '--tools', '', '--thinking', 'disabled'];
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  return args;
}

const OPTIONS = {
  dir: M26_DIR, milestone: 'M26', Driver: M16Driver, omitted: ['usage readings'],
  argsFor: (launch) => secretaryArgs(launch),
  toolPolicy: 'no tool is offered (--tools ""); any can_use_tool request would be denied, any other request gets an error reply',
};

/** Every transcript file under the configuration folder's `projects/`, by its name. */
function transcripts() {
  const root = path.join(CONFIG_DIR, 'projects');
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full); else if (entry.name.endsWith('.jsonl')) out.push(entry.name);
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

const scenario = (key, { model, effort, title }) => ({
  id: `m26-claude-${key}`, name: `m26-claude-${key}`, turns: 1,
  title, successCondition: 'one reply to the one user message, the `result` frame, and no transcript left under projects/',
  async run(ctx) {
    const before = new Set(transcripts());
    const resolved = { model: model ?? ctx.state.model ?? null, effort: effort === undefined ? ctx.state.effort ?? null : effort };
    const driver = await ctx.open({ launch: resolved, cwd: ctx.probe, initialize: { systemPrompt: [INSTRUCTIONS] } });
    const from = await ctx.prompt(driver, input(FIRST_PROMPT));
    const result = await ctx.maybeFrame(driver, (f) => typeKey(f) === 'result', from, 90_000);
    await ctx.close(driver);
    await sleep(1_000);
    const init = initOf(driver, 0)?.frame ?? null;
    const resultFrame = result?.frame ?? resultOf(driver, from)?.frame ?? null;
    const sessionId = init?.session_id ?? null;
    const after = transcripts();
    const notes = {
      launched: resolved, initializeOk: driver.sessionStart?.ok ?? null,
      init: init ? { model: init.model ?? null, permissionMode: init.permissionMode ?? null, tools: Array.isArray(init.tools) ? init.tools : null, mcpServers: Array.isArray(init.mcp_servers) ? init.mcp_servers.length : null, slashCommands: Array.isArray(init.slash_commands) ? init.slash_commands.length : null, skills: Array.isArray(init.skills) ? init.skills.length : null, agents: Array.isArray(init.agents) ? init.agents.length : null } : null,
      reply: replyFacts(ownText(driver, from)),
      assistantFrames: framesOf(driver, 'assistant', from).length,
      toolUses: framesOf(driver, 'assistant', from).flatMap((f) => (Array.isArray(f.frame.message?.content) ? f.frame.message.content : [])).filter((block) => block?.type === 'tool_use').length,
      result: resultFrame ? {
        subtype: resultFrame.subtype ?? null, isError: resultFrame.is_error === true, numTurns: resultFrame.num_turns ?? null, durationMs: resultFrame.duration_ms ?? null, apiMs: resultFrame.duration_api_ms ?? null,
        costUsd: resultFrame.total_cost_usd ?? null, usage: resultFrame.usage ? { input: resultFrame.usage.input_tokens ?? null, cacheCreation: resultFrame.usage.cache_creation_input_tokens ?? null, cacheRead: resultFrame.usage.cache_read_input_tokens ?? null, output: resultFrame.usage.output_tokens ?? null } : null,
        models: resultFrame.modelUsage ? Object.keys(resultFrame.modelUsage) : null,
      } : null,
      transcript: { sessionId: sessionId !== null, ofThisSession: sessionId !== null && after.includes(`${sessionId}.jsonl`), newFiles: after.filter((name) => !before.has(name)).length },
      outline: outline(driver, from).filter((row) => row.recv !== 'stream_event'),
    };
    return happened(notes, result?.index ?? null);
  },
});

const SCENARIOS = {
  'session-model': scenario('session-model', { title: "K1: the title request under M16's model at its lowest effort" }),
  'small-model': scenario('small-model', { model: 'haiku', effort: null, title: 'K1: the title request under `haiku`, with no effort named' }),
};

if (isMain(import.meta.url)) {
  await runSpike('m26-k1', (frame) => {
    if (frame.args.list) {
      for (const [key, entry] of Object.entries(SCENARIOS)) log(`${key.padEnd(14)}  1 prompt  ${entry.title}`);
      log(`total: ${Object.keys(SCENARIOS).length} prompts for one run of each`);
      return 0;
    }
    const chosen = SCENARIOS[String(frame.args.scenario ?? '')];
    if (!chosen) { warn(`usage: node spikes/m26/k1.mjs --list | --scenario ${Object.keys(SCENARIOS).join('|')} --confirm-turns 1 [--again] [--path <executable>]`); return 1; }
    log(`K1: ${secretaryArgs({ model: '<model>', effort: '<effort>' }).map((arg) => (arg === '' ? '""' : arg)).join(' ')}`);
    return runScenario('m26-k1', chosen, frame, OPTIONS);
  });
}
