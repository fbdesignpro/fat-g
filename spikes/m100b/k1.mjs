// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// M100b spike K1 (docs/planning/_archive/M100b-spec-sheet.md; C31, C36): Claude's `AskUserQuestion` declined by a
// `deny` from the user, with fat-g's words, under M21's launch — M16's as M20b leaves it, without
// `--disable-slash-commands`, with `--include-partial-messages` and background tasks off, plus
// `AskUserQuestion` in `--tools` — in M16's scratch configuration folder, with M10's notes files.
//
//   node spikes/m100b/k1.mjs --list
//   node spikes/m100b/k1.mjs --scenario decline --confirm-turns 1 [--again]
//
// Without --confirm-turns 1 it prints its plan and launches nothing. One invocation is one run; at
// most three runs (M10's ledger, under spikes/output/m100b). The run is a session of its own, left in
// the scratch configuration's history and named in the report.
//
// What a run records is never a text of the model's: the request's shape, the deny the spike sent,
// the CLI's own words in the tool's result, the frames that follow, the turn's bounds, and whether
// the model's reply is the one word its prompt names for a declined question.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { typeKey } from '../m10/claude/frames.mjs';
import { sleep } from '../m10/lib/deadlines.mjs';
import { SPIKES_DIR, isMain } from '../m10/lib/paths.mjs';
import { log, runSpike, warn } from '../m10/lib/spike.mjs';
import { TOOLS, didNotHappen, framesOf, happened, initOf, notRun, outline, ownText, resultOf, runScenario } from '../m16/lib/common.mjs';
import { M19ClaudeDriver, OMITTED_CLAUDE, received } from '../m19/lib/common.mjs';
import { typeCounts } from '../m21/lib/common.mjs';
import { FILES } from '../../tests/fixtures/project-files.mjs';

const M100B_DIR = path.join(SPIKES_DIR, 'output', 'm100b');

/** The launch as M21 left it (M21, C16). */
const QUESTION_TOOL = 'AskUserQuestion';
const EXTRA = ['--include-partial-messages'];
const SETTLED = Object.freeze({ launch: { extra: EXTRA, tools: [...TOOLS, QUESTION_TOOL] }, background: false });

/** fat-g's words to a question the user skipped (C31). */
export const DECLINE_MESSAGE = 'The user declined to answer in fat-g';

/** The one word the prompt asks for when the question is declined: all of the reply that is read. */
const DECLINED_WORD = 'PINEAPPLE';
const PROMPT = `Before you do anything else, ask me with your AskUserQuestion tool which colour I prefer, red or blue, offering those two as the options. If I answer, reply with that colour's name alone. If I decline to answer, do not ask again and use no other tool: reply with the single word ${DECLINED_WORD} and nothing else.`;

const blocksOf = (frame) => (Array.isArray(frame.message?.content) ? frame.message.content : []);
const isQuestionRequest = (frame) => frame?.type === 'control_request' && frame.request?.subtype === 'can_use_tool' && frame.request.tool_name === QUESTION_TOOL;

/** M19's driver, declining every question request as fat-g's Skip will (C31): `deny` with fat-g's words, no `interrupt`. */
class K1Driver extends M19ClaudeDriver {
  constructor(options) {
    super(options);
    this.declined = [];
  }

  incoming(frame, index) {
    if (!isQuestionRequest(frame)) { super.incoming(frame, index); return; }
    this.requestsSeen.push({ kind: 'can_use_tool', tool: QUESTION_TOOL, worker: Boolean(frame.request.agent_id), answer: 'deny' });
    const response = { subtype: 'success', request_id: frame.request_id, response: { behavior: 'deny', message: DECLINE_MESSAGE } };
    this.declined.push({ requestId: frame.request_id, index, atMs: this.tree.elapsed() });
    this.session.send({ type: 'control_response', response }).catch(() => {});
  }
}

const OPTIONS = { dir: M100B_DIR, milestone: 'M100b', Driver: K1Driver, omitted: OMITTED_CLAUDE };

/** The tool's result that answers the request's tool use: the CLI's fixed words, never the model's. */
function resultFacts(driver, request, deniedAt, from) {
  const entry = received(driver, from).find((f) => typeKey(f.frame) === 'user' && blocksOf(f.frame).some((b) => b.type === 'tool_result' && b.tool_use_id === request.tool_use_id)) ?? null;
  if (!entry) return null;
  const block = blocksOf(entry.frame).find((b) => b.type === 'tool_result' && b.tool_use_id === request.tool_use_id);
  const content = typeof block.content === 'string' ? block.content : Array.isArray(block.content) ? block.content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('') : '';
  return {
    index: entry.index, msAfterTheDeny: deniedAt === null ? null : Math.round(entry.ms - deniedAt), isError: block.is_error === true, contentIsString: typeof block.content === 'string',
    contentUnits: content.length, cliWords: content.slice(0, 400), holdsOurWords: content.includes(DECLINE_MESSAGE),
    toolUseResult: entry.frame.tool_use_result === undefined ? 'absent' : typeof entry.frame.tool_use_result === 'string' ? entry.frame.tool_use_result.slice(0, 400) : Object.keys(entry.frame.tool_use_result ?? {}).sort(),
  };
}

const SCENARIOS = {
  decline: {
    id: 'm100b-decline', name: 'm100b-question-decline', turns: 1, files: FILES,
    title: "K1: a question declined by a `deny` from the user with fat-g's words (C31)",
    successCondition: "The tool's result the CLI makes of the deny, the frames after it, whether the turn goes on to the model's reply and ends `success`, and no question asked again",
    async run(ctx) {
      if (!ctx.model) return notRun("no model chosen: run M16's --scenario discover first");
      const driver = await ctx.open(SETTLED);
      const uuid = randomUUID();
      const from = await ctx.prompt(driver, PROMPT, { uuid });
      const end = await ctx.turnEnd(driver, from);
      await sleep(1_500);
      const requests = received(driver, from).filter((f) => isQuestionRequest(f.frame));
      const first = requests[0] ?? null;
      const firstDeny = first === null ? null : driver.declined.find((d) => d.requestId === first.frame.request_id) ?? null;
      const init = initOf(driver, from)?.frame ?? null;
      const result = resultOf(driver, from) ?? null;
      const text = ownText(driver, from);
      const notes = {
        endStatus: end.status, isError: end.isError ?? null, terminal: end.terminalReason ?? null,
        questionRequests: requests.length,
        request: first === null ? null : { index: first.index, keys: Object.keys(first.frame.request).sort(), requiresUserInteraction: first.frame.request.requires_user_interaction ?? null, questions: (first.frame.request.input?.questions ?? []).length },
        denySent: first === null ? null : { behavior: 'deny', message: DECLINE_MESSAGE, interrupt: 'absent' },
        toolResult: first === null ? null : resultFacts(driver, first.frame.request, firstDeny?.atMs ?? null, from),
        framesAfterTheDeny: firstDeny === null ? [] : received(driver, from).filter((f) => f.ms >= firstDeny.atMs && typeKey(f.frame) !== 'stream_event').map((f) => ({ type: typeKey(f.frame), msAfterTheDeny: Math.round(f.ms - firstDeny.atMs) })),
        cancels: received(driver, from).filter((f) => typeKey(f.frame) === 'control_cancel_request').length,
        permissionDenied: framesOf(driver, 'system/permission_denied', from).length,
        toolCalls: driver.events(from).filter((e) => e.kind === 'tool-call').map((e) => e.name),
        replyIsTheDeclinedWord: text.trim().replace(/[.!]$/, '') === DECLINED_WORD, replyUnits: text.length,
        init: init ? { model: init.model ?? null, permissionMode: init.permissionMode ?? null, questionToolListed: (init.tools ?? []).includes(QUESTION_TOOL) } : null,
        result: result ? { index: result.index, subtype: result.frame.subtype ?? null, isError: result.frame.is_error === true, terminal: result.frame.terminal_reason ?? null, numTurns: result.frame.num_turns ?? null } : null,
        lifecycle: framesOf(driver, 'command_lifecycle', from).map((f) => ({ index: f.index, state: f.frame.state ?? null, namesOurId: f.frame.command_uuid === uuid })),
        sessionId: init?.session_id ?? null, typeCounts: typeCounts(driver, typeKey, from), outline: outline(driver, from, { sent: [uuid] }).filter((row) => row.recv !== 'stream_event'),
      };
      if (requests.length === 0) return didNotHappen('no AskUserQuestion request came', notes);
      return happened(notes, end.index);
    },
  },
};

if (isMain(import.meta.url)) {
  await runSpike('m100b-k1', (frame) => {
    if (frame.args.list) {
      for (const [key, scenario] of Object.entries(SCENARIOS)) log(`${key.padEnd(8)} ${String(scenario.turns).padStart(2)} prompt(s)  ${scenario.title}`);
      return 0;
    }
    const scenario = SCENARIOS[String(frame.args.scenario ?? '')];
    if (!scenario) { warn(`usage: node spikes/m100b/k1.mjs --list | --scenario ${Object.keys(SCENARIOS).join('|')} --confirm-turns <n> [--again] [--path <executable>]`); return 1; }
    log(`K1: M21's launch, with ${EXTRA.join(' ')} and --tools ${SETTLED.launch.tools.join(',')}; background tasks off; the scratch configuration folder`);
    return runScenario('m100b-k1', scenario, frame, OPTIONS);
  });
}
