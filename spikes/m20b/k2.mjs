// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// M20b spike K2 (docs/planning/_archive/M20b-spec-sheet.md; C55–C58, C60): what each of the CLI's commands
// does when written as a prompt under the launch without `--disable-slash-commands` (decision
// 0023), in M16's scratch configuration folder, the seed session of K1 resumed. Seven prompts at
// most, each announced; most are answered by the CLI itself with no model called.
//
//   node spikes/m20b/k2.mjs --list
//   node spikes/m20b/k2.mjs --scenario exit|quit|resume|login|logout|btw|compact --confirm-turns 1 [--again]
//
// Without --confirm-turns 1 it prints its plan and launches nothing (S6). One invocation is one
// run; at most three runs per scenario (M10's ledger, under spikes/output/m20b). `logout` is run
// last of all the Claude spikes: were it to sign the scratch folder out, only the maintainer could
// sign it in again (decision 0004; agents never log in).
//
// What a run records is never a text: whether the CLI answered by itself or a model did, whether
// the process ended, whether a `result` came and how, whether a new `init` named another session,
// the names the `init` frame's command list holds, and whether the saved session's history file
// grew (by size alone).
import { randomUUID } from 'node:crypto';
import { typeKey } from '../m10/claude/frames.mjs';
import { sleep } from '../m10/lib/deadlines.mjs';
import { isMain } from '../m10/lib/paths.mjs';
import { log, runSpike, warn } from '../m10/lib/spike.mjs';
import { CONFIG_DIR, framesOf, happened, initOf, notRun, outline, ownText, resultOf, runScenario } from '../m16/lib/common.mjs';
import { M19ClaudeDriver, OMITTED_CLAUDE, received } from '../m19/lib/common.mjs';
import { FILES } from '../../tests/fixtures/project-files.mjs';
import { M20B_DIR, QUESTIONS, historyBytes, readState, typeCounts } from './lib/common.mjs';

const OPTIONS = { dir: M20B_DIR, milestone: 'M20b', Driver: M19ClaudeDriver, omitted: OMITTED_CLAUDE };
const SETTLED = Object.freeze({ launch: { extra: ['--include-partial-messages'] }, background: false });

const blocksOf = (frame) => (Array.isArray(frame.message?.content) ? frame.message.content : []);

/** The prompts: a command each, written as a user would (C55), and what its answer is looked at for. */
const COMMANDS = {
  exit: { text: '/exit', title: "K2: `/exit` as a prompt: the process's end, or the CLI's answer" },
  quit: { text: '/quit', title: "K2: `/quit` as a prompt: the process's end, or the CLI's answer" },
  resume: { text: '/resume', title: "K2: `/resume` as a prompt: another session named, a list, or the CLI's answer" },
  login: { text: '/login', title: "K2: `/login` as a prompt: a login flow begun, or the CLI's answer (never followed)" },
  logout: { text: '/logout', title: "K2: `/logout` as a prompt: the scratch folder signed out, or the CLI's answer" },
  btw: { text: `/btw ${QUESTIONS.twoA.text}`, title: "K2: `/btw` with a question: whether a model answers, and whether the answer enters the conversation", looksFor: QUESTIONS.twoA.looksFor },
  compact: { text: '/compact', title: 'K2: `/compact` under the launch without the flag: a model called, and the boundary frame' },
};

const scenario = (key, { text, title, looksFor = null }) => ({
  id: `m20b-cmd-${key}`, name: `m20b-cmd-${key}`, turns: 1, atMost: true, files: FILES,
  title, successCondition: "The CLI's own answer or a model's, the turn's end or the process's, and what the `init` lists",
  async run(ctx) {
    const state = readState();
    if (!state.claudeSessionId) return notRun('no seed session: run k1 --scenario seed first');
    const driver = await ctx.open({ ...SETTLED, launch: { ...SETTLED.launch, resume: state.claudeSessionId } });
    await sleep(1_000);
    const bytesBefore = historyBytes(CONFIG_DIR, ctx.project, state.claudeSessionId);
    const uuid = randomUUID();
    const from = await ctx.prompt(driver, text, { uuid });
    const result = await ctx.maybeFrame(driver, (f) => typeKey(f) === 'result', from, 150_000);
    await sleep(2_000);
    const bytesAfter = historyBytes(CONFIG_DIR, ctx.project, state.claudeSessionId);
    const assistants = framesOf(driver, 'assistant', from);
    const text_ = ownText(driver, from);
    const init = initOf(driver, 0)?.frame ?? null;
    const initsAfter = framesOf(driver, 'system/init', from);
    const resultFrame = result?.frame ?? resultOf(driver, from)?.frame ?? null;
    const exit = driver.tree?.exitInfo ? { code: driver.tree.exitInfo.code ?? null, ms: driver.exitMs, msAfterThePrompt: driver.exitMs === null ? null : Math.round(driver.exitMs - (driver.session.frames.find((f) => f.index === from)?.ms ?? 0)) } : null;
    const notes = {
      command: text.split(' ')[0],
      answeredByTheCliItself: assistants.some((f) => f.frame.message?.model === '<synthetic>' && 'local_command_source' in f.frame),
      answeredByTheModel: assistants.some((f) => f.frame.message?.model !== '<synthetic>'),
      answerUnits: text_.length, answerMentionsAnAddress: /https?:\/\//i.test(text_), answerSaysNotAvailable: /not (available|supported)|unknown command|cannot|can't/i.test(text_),
      ...(looksFor ? { answerLooksRight: looksFor.test(text_) } : {}),
      resultCame: resultFrame !== null, result: resultFrame ? { subtype: resultFrame.subtype ?? null, isError: resultFrame.is_error === true, numTurns: resultFrame.num_turns ?? null } : null,
      processEnded: exit !== null, exit,
      initsAfterThePrompt: initsAfter.map((f) => ({ sameSession: f.frame.session_id === state.claudeSessionId })),
      lifecycle: framesOf(driver, 'command_lifecycle', from).map((f) => ({ state: f.frame.state ?? null, namesOurId: f.frame.command_uuid === uuid })),
      compactBoundaries: framesOf(driver, 'system/compact_boundary', from).length,
      newConversationFrames: received(driver, from).filter((f) => typeKey(f.frame) === 'conversation_reset' || 'new_conversation_id' in (f.frame ?? {})).length,
      initCommands: Array.isArray(init?.slash_commands) ? init.slash_commands : null, initSkills: Array.isArray(init?.skills) ? init.skills.length : null,
      historyFile: { found: bytesBefore !== null, bytesBefore, bytesAfter, grewBy: bytesBefore !== null && bytesAfter !== null ? bytesAfter - bytesBefore : null },
      typeCounts: typeCounts(driver, typeKey, from), outline: outline(driver, from, { sent: [uuid] }).filter((row) => row.recv !== 'stream_event'),
    };
    // Each is a finding whatever it shows: the case is what the CLI does with the command.
    return happened(notes, result?.index ?? null);
  },
});

const SCENARIOS = Object.fromEntries(Object.entries(COMMANDS).map(([key, entry]) => [key, scenario(key, entry)]));

if (isMain(import.meta.url)) {
  await runSpike('m20b-k2', (frame) => {
    if (frame.args.list) {
      for (const [key, entry] of Object.entries(SCENARIOS)) log(`${key.padEnd(10)}  1 prompt at most  ${entry.title}`);
      log(`total: ${Object.keys(SCENARIOS).length} prompts at most for one run of each; most are answered by the CLI with no model called`);
      return 0;
    }
    const chosen = SCENARIOS[String(frame.args.scenario ?? '')];
    if (!chosen) { warn(`usage: node spikes/m20b/k2.mjs --list | --scenario ${Object.keys(SCENARIOS).join('|')} --confirm-turns 1 [--again] [--path <executable>]`); return 1; }
    log("K2: M16's launch less --disable-slash-commands, with --include-partial-messages; the seed session resumed");
    return runScenario('m20b-k2', chosen, frame, OPTIONS);
  });
}
