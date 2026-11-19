// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// M19b spike K2 (docs/planning/_archive/M19b-spec-sheet.md; C2, C19, C22, C46, C49): how each installed CLI's
// answers name a file. Each CLI under its production launch as M19 leaves it — Codex's session
// handshake with an agent message's deltas kept, Claude's chat launch with partial messages, in
// M16's scratch configuration folder — in a scratch folder that holds a `README.md`, a source file
// and a Markdown file in a folder whose name has a space. Three prompts at most for each CLI.
//
//   node spikes/m19b/k2.mjs --list
//   node spikes/m19b/k2.mjs --cli codex|claude --scenario line|readme|space [--confirm-turns 1] [--again]
//   node spikes/m19b/k2.mjs --reread      the mentions read again from the raw captures: launches nothing
//
// Without --confirm-turns 1 it prints its plan and launches nothing (S6). One invocation is one run
// of one prompt; at most three runs per scenario (M10's ledger, under spikes/output/m19b). The
// runners are M15's and M16's, with M19's drivers: Codex's threads start in M15's scratch folder,
// saved as the app's are (`node spikes/m15/resume.mjs --cleanup` deletes them, with M15's own);
// Claude's sessions are saved in the scratch configuration folder, with the model and effort M16's
// `discover` scenario left in spikes/output/m16/state.json.
//
// No prompt says how a file is to be named: fat-g sends a session no instruction of its own, so the
// form is each CLI's and its model's. What a run notes is each mention of one of the spike's own
// files, in the form the answer wrote it, and the answer's other code spans (lib/mentions.mjs).
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { sleep } from '../m10/lib/deadlines.mjs';
import { isMain, writeJson } from '../m10/lib/paths.mjs';
import { log, runSpike, warn } from '../m10/lib/spike.mjs';
import * as codex from '../m15/lib/common.mjs';
import * as claude from '../m16/lib/common.mjs';
import { CODEX_TEXT_DELTA, M19ClaudeDriver, M19CodexDriver, OMITTED_CLAUDE, OMITTED_CODEX, received } from '../m19/lib/common.mjs';
import { FILES, FUNCTION_LINE, M19B_DIR } from './lib/common.mjs';
import { createMentionReader } from './lib/mentions.mjs';

const KNOWN = Object.keys(FILES);

/** The three prompts (the sheet's K2). The first names a function, the second a file, the third a folder. */
const PROMPTS = {
  line: { title: 'where a named function is, with its line', prompt: 'Where is the function nextHighTide defined in this project? Give me the file and the line.' },
  readme: { title: 'a summary of README.md that points to it', prompt: "Summarise this project's README in two sentences, and point me to the file." },
  space: { title: 'what the Markdown file in the folder with a space holds', prompt: 'Which Markdown file is in the folder called field notes, and what does it hold? Answer in two sentences.' },
};

/** What the answers name, message by message, and all of it at once. */
function namings(root, messages) {
  const read = createMentionReader({ root, files: KNOWN });
  const each = messages.map((message, index) => ({ phase: message.phase, last: index === messages.length - 1, ...read(message.text) }));
  const all = each.flatMap((message) => message.mentions);
  const count = (key) => all.reduce((counts, mention) => { const value = String(mention[key]); counts[value] = (counts[value] ?? 0) + 1; return counts; }, {});
  return {
    messages: each,
    summary: { mentions: all.length, byForm: count('form'), byPathKind: count('pathKind'), lineForms: count('lineForm'), separators: count('separators'), space: count('space'), bareNames: all.filter((mention) => mention.bareName).length, lineRight: all.filter((mention) => mention.line !== null).map((mention) => mention.line === FUNCTION_LINE) },
  };
}

/** An answer's texts, from received frames: Codex's completed agent messages of the session's thread, each with its phase. */
const codexMessages = (entries, threadId) => entries.filter((f) => f.frame?.method === 'item/completed' && f.frame.params?.item?.type === 'agentMessage' && f.frame.params.threadId === threadId).map((f) => ({ phase: f.frame.params.item.phase ?? null, text: String(f.frame.params.item.text ?? '') }));
/** Claude's: each text block of the session's own `assistant` frames. */
const claudeMessages = (entries) => entries.filter((f) => f.frame?.type === 'assistant' && f.frame.parent_tool_use_id == null).flatMap((f) => (Array.isArray(f.frame.message?.content) ? f.frame.message.content : []).filter((block) => block.type === 'text').map((block) => ({ phase: null, text: String(block.text ?? '') })));

/**
 * The mentions read again from the raw captures, with the reader as it is now: a form the reader
 * did not know when a run was made costs no second prompt. Launches nothing. Each capture's notes
 * are rewritten, and say so.
 */
function reread() {
  for (const cli of ['codex', 'claude']) {
    const dir = path.join(M19B_DIR, 'raw', cli);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter((file) => file.endsWith('.json')).sort()) {
      const file = path.join(dir, name);
      const capture = JSON.parse(readFileSync(file, 'utf8'));
      const entries = (capture.frames ?? []).filter((f) => f.dir === 'recv');
      const threadId = cli === 'codex' ? entries.find((f) => f.index === capture.sessionStart?.replyIndex)?.frame?.result?.thread?.id : null;
      const root = cli === 'codex' ? capture.sessionStart?.request?.cwd : capture.launch?.cwd;
      if (typeof root !== 'string') { warn(`${cli}/${name}: no session folder in the capture; left as it is`); continue; }
      const fresh = namings(root, cli === 'codex' ? codexMessages(entries, threadId) : claudeMessages(entries));
      capture.run.notes = { ...capture.run.notes, ...fresh, reread: `the mentions were read again from this capture's frames on ${new Date().toISOString().slice(0, 10)}` };
      writeJson(file, capture);
      log(`${cli}/${name} (${capture.run.outcome}; ${capture.cli?.version}):`);
      for (const message of fresh.messages) {
        log(`  ${message.phase ?? (message.last ? 'last text' : 'earlier text')}: ${message.units} units, ${message.links} link(s), ${message.codeSpans} code span(s)${message.otherCodeSpans.length ? `; other code spans ${JSON.stringify(message.otherCodeSpans)}` : ''}${message.linesInProse.length ? `; in prose ${JSON.stringify(message.linesInProse)}` : ''}`);
        for (const mention of message.mentions) log(`    ${JSON.stringify(mention)}`);
      }
    }
  }
  return 0;
}

// ── Codex: M15's runner, production's handshake less the opt-out of an agent message's deltas ──
const CODEX_OPTIONS = { dir: M19B_DIR, milestone: 'M19b', Driver: M19CodexDriver, omitted: OMITTED_CODEX };

const codexScenario = (key, { title, prompt }) => ({
  id: `m19b-${key}`, name: `m19b-${key}`, turns: 1, files: FILES,
  title: `K2: ${title}`, successCondition: "An answer that names a file, and the turn's end",
  async run(ctx) {
    const driver = await ctx.open();
    const model = await codex.pickModel(driver);
    if (!model.model) return codex.notRun('the CLI listed no model');
    const started = await ctx.startThread(driver, { model: model.model });
    if (!started.ok) return codex.didNotHappen('thread/start was refused');
    if (!driver.sessionStart.check.passed) return codex.notRun('the session-start reply differed from the request (M15, C21)', { rows: driver.sessionStart.check.rows });
    const from = driver.nextIndex;
    // The turn as the app starts it (session.ts): the model, the effort, an id of fat-g's own.
    await ctx.prompt(driver, prompt, { model: model.model, ...(model.effort ? { effort: model.effort } : {}), clientUserMessageId: randomUUID() });
    const end = await ctx.turnEnd(driver, from);
    await sleep(1_500);
    const messages = codexMessages(received(driver, from), driver.threadId);
    const notes = { model, endStatus: end.status, sessionFolder: 'the thread\'s `cwd`; the app-server itself runs in another folder', toolCalls: driver.events(from).filter((e) => e.kind === 'tool-call' && e.index <= end.index).map((e) => e.name), textDeltas: received(driver, from).filter((f) => f.frame?.method === CODEX_TEXT_DELTA).length, ...namings(ctx.scratch, messages), outline: codex.outline(driver, from).filter((row) => row.method !== CODEX_TEXT_DELTA) };
    if (notes.summary.mentions === 0) return codex.didNotHappen(messages.length ? 'the answer named none of the files' : 'no agent message came', notes);
    return codex.happened(notes, end.index);
  },
});

// ── Claude: M16's runner, its settled launch with partial messages (src/main/providers/claude/chat-launch.ts) ──
const CLAUDE_OPTIONS = { dir: M19B_DIR, milestone: 'M19b', Driver: M19ClaudeDriver, omitted: OMITTED_CLAUDE };
const SETTLED = Object.freeze({ launch: { extra: ['--disable-slash-commands', '--include-partial-messages'] }, background: false });

const claudeScenario = (key, { title, prompt }) => ({
  id: `m19b-${key}`, name: `m19b-${key}`, turns: 1, files: FILES,
  title: `K2: ${title}`, successCondition: "An answer that names a file, and the turn's end",
  async run(ctx) {
    if (!ctx.model) return claude.notRun('no model chosen: run M16\'s --scenario discover first');
    const driver = await ctx.open(SETTLED);
    const uuid = randomUUID();
    const from = await ctx.prompt(driver, prompt, { uuid });
    const end = await ctx.turnEnd(driver, from);
    await sleep(1_500);
    const messages = claudeMessages(received(driver, from));
    const init = claude.initOf(driver, from)?.frame ?? null;
    const notes = { model: { model: init?.model ?? null, asked: ctx.model, effort: ctx.effort }, endStatus: end.status, isError: end.isError ?? null, sessionFolder: 'the process\'s working folder', toolCalls: driver.events(from).filter((e) => e.kind === 'tool-call' && e.index <= end.index).map((e) => e.name), streamEvents: received(driver, from).filter((f) => f.frame?.type === 'stream_event').length, ...namings(ctx.project, messages), outline: claude.outline(driver, from, { sent: [uuid] }).filter((row) => row.recv !== 'stream_event') };
    if (notes.summary.mentions === 0) return claude.didNotHappen(messages.length ? 'the answer named none of the files' : 'no text came', notes);
    return claude.happened(notes, end.index);
  },
});

const SCENARIOS = {
  codex: Object.fromEntries(Object.entries(PROMPTS).map(([key, entry]) => [key, codexScenario(key, entry)])),
  claude: Object.fromEntries(Object.entries(PROMPTS).map(([key, entry]) => [key, claudeScenario(key, entry)])),
};

if (isMain(import.meta.url)) {
  await runSpike('m19b-k2', (frame) => {
    if (frame.args.list) {
      for (const cli of Object.keys(SCENARIOS)) for (const [key, scenario] of Object.entries(SCENARIOS[cli])) log(`${cli.padEnd(7)} ${key.padEnd(7)} ${scenario.turns} turn  ${scenario.title}`);
      log(`total: ${Object.values(SCENARIOS).flatMap((set) => Object.values(set)).reduce((sum, scenario) => sum + scenario.turns, 0)} turn(s) for one run of each: three to each CLI`);
      return 0;
    }
    if (frame.args.reread) return reread();
    const cli = String(frame.args.cli ?? '');
    const scenario = SCENARIOS[cli]?.[String(frame.args.scenario ?? '')];
    if (!scenario) { warn(`usage: node spikes/m19b/k2.mjs --list | --reread | --cli codex|claude --scenario ${Object.keys(PROMPTS).join('|')} [--confirm-turns 1] [--again] [--path <executable>]`); return 1; }
    if (cli === 'codex') {
      log(`K2: production's handshake less the opt-out of ${CODEX_TEXT_DELTA}; no experimental API`);
      return codex.runScenario('m19b-k2', scenario, frame, CODEX_OPTIONS);
    }
    log(`K2: M16's launch with ${SETTLED.launch.extra.join(' ')}`);
    return claude.runScenario('m19b-k2', scenario, frame, CLAUDE_OPTIONS);
  });
}
