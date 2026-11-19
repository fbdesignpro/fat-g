// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// M23 spike K2 (docs/planning/_archive/M23-spec-sheet.md; C23, C42, C43, C60): Claude under the app's launch —
// M16's as M20b leaves it, with `--include-partial-messages` and background tasks off — under the
// reading mode's tool list and `default`, in M16's scratch configuration folder (C70): the
// maintainer's own configuration is neither read nor changed.
//
//   node spikes/m23/k2.mjs --list
//   node spikes/m23/k2.mjs --scenario <name> --confirm-turns <n> [--again]
//
// Without --confirm-turns equal to the scenario's count it prints its plan and launches nothing
// (C70). One invocation is one run; at most three runs per scenario (M10's ledger, under
// spikes/output/m23). `image` writes a user frame of a text block and one image block (C21, C23);
// `big-image` one whose image is at the sheet's 5 MiB bound (C2). `steer-text` starts a turn of text
// alone and writes a second user frame while it is written; `steer-tool` the same during a turn that
// reads files (C36, C42). `stop-held` writes a second frame and then `interrupt` with
// `cancel_queued: true` (C43). `skill` puts a skill into the scratch configuration and invokes it as
// `/m23-marker` (C60). Every scenario records what the `initialize` reply and `init` list of commands
// and skills (C60).
//
// The images are the harness's own, drawn from a formula (lib/common.mjs). Every `can_use_tool`
// request is denied, as the app denies one under the reading mode; a read inside the scratch
// project asks nothing.
//
// What a run records is never a text of the model's: each prompt's lifecycle frames, which prompt
// each frame answers, the `user` frames that came back, the count of `result` frames, whether an
// answer holds the marker word the spike dictated, the sizes of the largest frames, and the lists
// as counts with the CLI's own names among them.
import { randomUUID } from 'node:crypto';
import { typeKey } from '../m10/claude/frames.mjs';
import { sleep } from '../m10/lib/deadlines.mjs';
import { isMain } from '../m10/lib/paths.mjs';
import { log, runSpike, warn } from '../m10/lib/spike.mjs';
import { TOOLS, didNotHappen, framesOf, happened, initOf, notRun, outline, runScenario } from '../m16/lib/common.mjs';
import { M19ClaudeDriver, OMITTED_CLAUDE, received } from '../m19/lib/common.mjs';
import { tidy, typeCounts } from '../m22b/lib/common.mjs';
import { FILES } from '../../tests/fixtures/project-files.mjs';
import { COLOUR_WORDS, M23_DIR, MARKERS, PROMPTS, SKILL_MD, SKILL_NAME, coloursIn, holds, imageFacts, images } from './lib/common.mjs';

const EXTRA = ['--include-partial-messages'];
/** The app's reading-mode tool list (src/main/providers/claude/chat-modes.ts): the four that read and the question tool, under `default`. */
const READING = Object.freeze([...TOOLS, 'AskUserQuestion']);
const LAUNCH = Object.freeze({ extra: EXTRA, tools: READING, permissionMode: 'default' });
const IMAGE = Object.freeze({ redBlue: 'two-colours-red-blue.png', noise: 'noise-at-the-bound.png' });

const OPTIONS = {
  dir: M23_DIR, milestone: 'M23', Driver: M19ClaudeDriver, omitted: OMITTED_CLAUDE,
  toolPolicy: 'every can_use_tool request is denied, as the app denies one under the reading mode; a read inside the scratch project asks nothing',
};

const blocksOf = (frame) => (Array.isArray(frame?.message?.content) ? frame.message.content : []);
const foldersOf = (ctx) => ({ 'scratch project': ctx.project, 'configuration folder': ctx.config, 'outside every root': ctx.outside });

/** A user frame as the app writes one (chat-wire.ts): the id fat-g makes for the message, `content` a text or an array of blocks (C21). Counted as a prompt. */
async function sendUser(ctx, driver, content, uuid) {
  ctx.countTurn();
  const from = driver.nextIndex;
  driver.turnActive = true;
  await driver.session.send({ type: 'user', uuid, message: { role: 'user', content }, parent_tool_use_id: null, session_id: '' });
  return from;
}
const imageBlock = (bytes) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: bytes.toString('base64') } });

/** The names a run gives its prompts' ids, so that a note never holds an id. */
const whichOf = (names, id) => (typeof id === 'string' ? names[id] ?? 'other' : null);
const msOf = (driver, index) => driver.session.frames.find((f) => f.index === index)?.ms ?? null;

/** Each `command_lifecycle` frame from `from` on: which prompt, its state, when. */
const lifecycle = (driver, from, names) => framesOf(driver, 'command_lifecycle', from).map((f) => ({ index: f.index, ms: Math.round(f.ms), which: whichOf(names, f.frame.command_uuid), state: f.frame.state ?? null, keys: Object.keys(f.frame).sort() }));
/** Frames that carry a prompt's id as the one they answer (the SDK's stamp): which prompt, on what frame. */
const stamped = (driver, from, names) => received(driver, from).filter((f) => f.frame && typeof f.frame === 'object' && ('user_message_uuid' in f.frame || 'user_message_uuids' in f.frame)).map((f) => ({ index: f.index, type: typeKey(f.frame), which: 'user_message_uuid' in f.frame ? whichOf(names, f.frame.user_message_uuid) : Array.isArray(f.frame.user_message_uuids) ? f.frame.user_message_uuids.map((id) => whichOf(names, id)) : null }));
/** Every `user` frame received from `from` on: whose id it carries and what blocks it holds — an echo, or a tool's result. */
const userFrames = (driver, from, names) => framesOf(driver, 'user', from).map((f) => ({ index: f.index, ms: Math.round(f.ms), which: f.frame.uuid ? whichOf(names, f.frame.uuid) : 'no uuid', blocks: blocksOf(f.frame).map((b) => b?.type ?? null), parentToolUse: f.frame.parent_tool_use_id != null }));
const results = (driver, from, names) => framesOf(driver, 'result', from).map((f) => ({ index: f.index, ms: Math.round(f.ms), subtype: f.frame.subtype ?? null, isError: f.frame.is_error === true, terminal: f.frame.terminal_reason ?? null, numTurns: f.frame.num_turns ?? null, answers: 'user_message_uuid' in f.frame ? whichOf(names, f.frame.user_message_uuid) : Array.isArray(f.frame.user_message_uuids) ? f.frame.user_message_uuids.map((id) => whichOf(names, id)) : 'unstamped' }));
/** The model's text from `from` to `to` (inclusive), joined: tested for a word, never written down. */
const textsBetween = (driver, from, to = Number.MAX_SAFE_INTEGER) => framesOf(driver, 'assistant', from).filter((f) => f.index <= to).flatMap((f) => blocksOf(f.frame).filter((b) => b?.type === 'text').map((b) => String(b.text ?? ''))).join('\n');
const toolCalls = (driver, from, to = Number.MAX_SAFE_INTEGER) => framesOf(driver, 'assistant', from).filter((f) => f.index <= to).flatMap((f) => blocksOf(f.frame).filter((b) => b?.type === 'tool_use').map((b) => b.name));
const imageBlocksReceived = (driver, from) => received(driver, from).reduce((n, f) => n + blocksOf(f.frame).filter((b) => b?.type === 'image').length, 0);
/** The CLI's own words where a turn failed: the text of an `assistant` frame that carries an error, or the result's, around the folders' names. */
const failureWords = (driver, from, folders) => [...framesOf(driver, 'assistant', from).filter((f) => f.frame.error).map((f) => textsBetween(driver, f.index, f.index)), ...framesOf(driver, 'result', from).filter((f) => f.frame.is_error === true && typeof f.frame.result === 'string').map((f) => f.frame.result)].map((text) => tidy(text, folders, 300));

/** Of `init`: the command, skill and capability lists (C60), as counts and the CLI's own names among them, never the user's. */
function initFacts(init) {
  if (!init) return null;
  const list = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === 'string') : null);
  const commands = list(init.slash_commands);
  const skills = list(init.skills);
  const terminal = list(init.terminal_slash_commands);
  return {
    keys: Object.keys(init).sort(), permissionMode: init.permissionMode ?? null,
    slashCommands: commands ? { count: commands.length, hasClear: commands.includes('clear'), hasModel: commands.includes('model'), hasCompact: commands.includes('compact'), hasTheSpikesSkill: commands.includes(SKILL_NAME), skillsAmongThem: skills ? skills.filter((s) => commands.includes(s)).length : null, terminalOnesAmongThem: terminal ? terminal.filter((t) => commands.includes(t)).length : null } : 'absent',
    skills: skills ? { count: skills.length, hasTheSpikesSkill: skills.includes(SKILL_NAME) } : 'absent',
    terminalSlashCommands: terminal ?? 'absent',
    capabilities: list(init.capabilities) ?? 'absent',
  };
}

/** Of the `initialize` reply: its `commands` (C60), as counts and shapes. */
function initializeFacts(reply) {
  if (!reply || typeof reply !== 'object') return null;
  const commands = Array.isArray(reply.commands) ? reply.commands : null;
  const has = (name) => (commands ?? []).some((c) => c?.name === name);
  return {
    keys: Object.keys(reply).sort(), currentPermissionMode: reply.current_permission_mode ?? null,
    commands: commands ? { count: commands.length, entryKeys: Object.keys(commands[0] ?? {}).sort(), withDescription: commands.filter((c) => typeof c?.description === 'string' && c.description.length > 0).length, withArgumentHint: commands.filter((c) => typeof c?.argumentHint === 'string' && c.argumentHint.length > 0).length, namesWithWhiteSpace: commands.filter((c) => /\s/.test(String(c?.name ?? ''))).length, hasClear: has('clear'), hasModel: has('model'), hasCompact: has('compact'), hasTheSpikesSkill: has(SKILL_NAME) } : 'absent',
  };
}

/** What every scenario notes of a run from `from` on. */
const common = (driver, from, names, extra = {}) => ({
  ...extra,
  lifecycle: lifecycle(driver, from, names), stamped: stamped(driver, from, names), userFrames: userFrames(driver, from, names), results: results(driver, from, names),
  inits: framesOf(driver, 'system/init', from).length, commandsChanged: framesOf(driver, 'system/commands_changed', from).length,
  typeCounts: typeCounts(driver, typeKey, from), largestFrames: driver.largest(3),
  outline: outline(driver, from, { sent: Object.keys(names) }).filter((row) => row.recv !== 'stream_event'),
});

/** The launch under the app's reading mode: the driver, with the `initialize` reply's facts. */
async function openSession(ctx) {
  const driver = await ctx.open({ launch: LAUNCH, background: false });
  return driver;
}

const isTextDelta = (f) => typeKey(f) === 'stream_event' && f.event?.type === 'content_block_delta' && f.event?.delta?.type === 'text_delta';
const isToolUse = (f) => typeKey(f) === 'assistant' && blocksOf(f).some((b) => b?.type === 'tool_use');
const isResult = (f) => typeKey(f) === 'result';

/** One image prompt through to its end (C21, C23): the frame of a text block and one image block. */
async function imageTurn(ctx, name, prompt, words) {
  if (!ctx.model) return notRun("no model chosen: run M16's --scenario discover first");
  const driver = await openSession(ctx);
  const bytes = images()[name];
  const uuid = randomUUID();
  const names = { [uuid]: 'the image prompt' };
  const from = await sendUser(ctx, driver, [{ type: 'text', text: prompt }, imageBlock(bytes)], uuid);
  const end = await ctx.turnEnd(driver, from);
  await sleep(1_500);
  const text = textsBetween(driver, from);
  const notes = {
    model: ctx.model, image: imageFacts(name, bytes), initialize: initializeFacts(driver.initializeReply), init: initFacts(initOf(driver, from)?.frame),
    endStatus: end.status, isError: end.isError ?? null, terminal: end.terminalReason ?? null,
    answerNames: Object.fromEntries(Object.entries(words).map(([key, pattern]) => [key, pattern.test(text)])), answerUnits: text.length,
    imageBlocksReceived: imageBlocksReceived(driver, from), failureWords: failureWords(driver, from, foldersOf(ctx)),
  };
  return happened(common(driver, from, names, notes), end.index);
}

/** A second user frame written while a turn runs (C36, C42): after `trigger`'s frame, `pause` later; then the first result, and a second within 90 s if one comes. */
async function steerTurn(ctx, first, second, marker, { trigger, pause, label }) {
  if (!ctx.model) return notRun("no model chosen: run M16's --scenario discover first");
  const driver = await openSession(ctx);
  const [uuid1, uuid2] = [randomUUID(), randomUUID()];
  const names = { [uuid1]: 'the first prompt', [uuid2]: 'the second frame' };
  const from = await sendUser(ctx, driver, first, uuid1);
  const hit = await ctx.frame(driver, trigger, from, 90_000);
  await sleep(pause);
  const secondFrom = await sendUser(ctx, driver, second, uuid2);
  const secondAt = driver.tree.elapsed();
  const end = await ctx.turnEnd(driver, from);
  const another = await ctx.maybeFrame(driver, isResult, end.index + 1, 90_000);
  await sleep(1_500);
  const notes = {
    model: ctx.model, case: label, initialize: initializeFacts(driver.initializeReply), init: initFacts(initOf(driver, from)?.frame),
    secondFrame: { msAfterTheTrigger: Math.round(secondAt - (msOf(driver, hit.index) ?? secondAt)), triggerType: typeKey(hit.frame), index: secondFrom },
    firstResult: { index: end.index, status: end.status, isError: end.isError ?? null, terminal: end.terminalReason ?? null },
    secondResult: another ? { index: another.index, msAfterTheFirst: Math.round((msOf(driver, another.index) ?? 0) - (msOf(driver, end.index) ?? 0)), subtype: another.frame.subtype ?? null, isError: another.frame.is_error === true } : null,
    marker: { beforeTheFirstResult: holds(textsBetween(driver, from, end.index), marker), afterIt: holds(textsBetween(driver, end.index + 1), marker) },
    toolCalls: { beforeTheSecondFrame: toolCalls(driver, from, secondFrom - 1), afterIt: toolCalls(driver, secondFrom) },
  };
  return happened(common(driver, from, names, notes), end.index);
}

const SCENARIOS = {
  image: {
    id: 'm23-image', name: 'm23-claude-image', turns: 1, files: FILES,
    title: 'K2: a user frame of a text block and one image block, under the app\'s launch (C21, C23)',
    successCondition: "The frame taken, the answer naming the image's colours, what the CLI gives back of the image, and the initialize reply's and init's command lists",
    run: (ctx) => imageTurn(ctx, IMAGE.redBlue, PROMPTS.image, { red: COLOUR_WORDS.red, blue: COLOUR_WORDS.blue }),
  },

  'big-image': {
    id: 'm23-big-image', name: 'm23-claude-big-image', turns: 1, files: FILES,
    title: "K2: a user frame whose image is noise at the sheet's 5 MiB bound, in one line (C2, C23)",
    successCondition: 'Whether the line is taken and the turn runs, the largest frame that comes back, and what the CLI says when the image is refused',
    run: (ctx) => imageTurn(ctx, IMAGE.noise, PROMPTS.bigImage, { noise: COLOUR_WORDS.noise }),
  },

  'steer-text': {
    id: 'm23-steer-text', name: 'm23-claude-steer-text', turns: 2, files: FILES,
    title: 'K2: a turn of text alone, with a second user frame written while it is written (C36, C42)',
    successCondition: 'The lifecycle frames of both prompts, whether one result or two close them, and where the marker word appears',
    run: (ctx) => steerTurn(ctx, PROMPTS.countClaude, PROMPTS.steerClaudeText, MARKERS.steerClaudeText, { trigger: isTextDelta, pause: 1_000, label: 'text alone' }),
  },

  'steer-tool': {
    id: 'm23-steer-tool', name: 'm23-claude-steer-tool', turns: 2, files: FILES,
    title: 'K2: a turn that reads three files, with a second user frame written after its first tool call (C36, C42)',
    successCondition: 'Whether the second frame is folded into the turn at a tool boundary, how many files are still read, and the lifecycle frames',
    run: (ctx) => steerTurn(ctx, PROMPTS.readThree, PROMPTS.steerClaudeTool, MARKERS.steerClaudeTool, { trigger: isToolUse, pause: 300, label: 'a tool call' }),
  },

  'stop-held': {
    id: 'm23-stop-held', name: 'm23-claude-stop-held', turns: 2, atMost: true, files: FILES,
    title: 'K2: a second frame written during a turn, then interrupt with cancel_queued: true (C43)',
    successCondition: "The interrupt reply's still_queued and cancelled lists, a cancelled lifecycle frame for the held frame, and no turn of its own after the Stop",
    async run(ctx) {
      if (!ctx.model) return notRun("no model chosen: run M16's --scenario discover first");
      const driver = await openSession(ctx);
      const [uuid1, uuid2] = [randomUUID(), randomUUID()];
      const names = { [uuid1]: 'the first prompt', [uuid2]: 'the held frame' };
      const from = await sendUser(ctx, driver, PROMPTS.countHeld, uuid1);
      await ctx.frame(driver, isTextDelta, from, 90_000);
      await sleep(1_000);
      const secondFrom = await sendUser(ctx, driver, PROMPTS.heldSecond, uuid2);
      const queued = await ctx.maybeFrame(driver, (f) => typeKey(f) === 'command_lifecycle' && f.command_uuid === uuid2, secondFrom, 5_000);
      await sleep(500);
      const stopAt = driver.tree.elapsed();
      const interrupt = await driver.request('interrupt', { cancel_queued: true });
      const end = await ctx.turnEnd(driver, from);
      const another = await ctx.maybeFrame(driver, isResult, end.index + 1, 20_000);
      await sleep(2_000);
      const value = interrupt.ok && interrupt.value && typeof interrupt.value === 'object' ? interrupt.value : null;
      const mapped = (list) => (Array.isArray(list) ? list.map((id) => whichOf(names, id)) : 'absent');
      const notes = {
        model: ctx.model, initialize: initializeFacts(driver.initializeReply), init: initFacts(initOf(driver, from)?.frame),
        heldFrame: { queuedBeforeTheStop: queued ? queued.frame.state ?? null : 'no lifecycle frame within 5 s', index: secondFrom },
        interrupt: { ok: interrupt.ok, msToReply: Math.round((msOf(driver, interrupt.index) ?? stopAt) - stopAt), keys: value ? Object.keys(value).sort() : null, stillQueued: value ? mapped(value.still_queued) : null, cancelled: value ? mapped(value.cancelled) : null, error: interrupt.ok ? null : tidy(interrupt.error, foldersOf(ctx)) },
        firstResult: { index: end.index, status: end.status, isError: end.isError ?? null, terminal: end.terminalReason ?? null },
        secondResult: another ? { index: another.index, subtype: another.frame.subtype ?? null, isError: another.frame.is_error === true } : null,
        heldRan: holds(textsBetween(driver, from), MARKERS.held),
        framesAfterTheStop: received(driver, from).filter((f) => f.ms >= stopAt && typeKey(f.frame) !== 'stream_event').map((f) => ({ type: typeKey(f.frame), msAfterTheStop: Math.round(f.ms - stopAt), ...(typeKey(f.frame) === 'command_lifecycle' ? { which: whichOf(names, f.frame.command_uuid), state: f.frame.state ?? null } : {}) })),
      };
      if (!interrupt.ok) return didNotHappen('the interrupt was refused', common(driver, from, names, notes));
      return happened(common(driver, from, names, notes), end.index);
    },
  },

  skill: {
    id: 'm23-skill', name: 'm23-claude-skill', turns: 1, files: FILES,
    title: "K2: a skill in the scratch configuration's skills folder, listed by init and invoked as /m23-marker (C60)",
    successCondition: "The skill among init's slash_commands and skills and the initialize reply's commands, and the answer holding its marker word",
    async run(ctx) {
      if (!ctx.model) return notRun("no model chosen: run M16's --scenario discover first");
      ctx.writeConfig(`skills/${SKILL_NAME}/SKILL.md`, SKILL_MD);
      const driver = await openSession(ctx);
      const uuid = randomUUID();
      const names = { [uuid]: 'the skill prompt' };
      const from = await sendUser(ctx, driver, PROMPTS.skillClaude, uuid);
      const end = await ctx.turnEnd(driver, from);
      await sleep(1_500);
      const notes = {
        model: ctx.model, initialize: initializeFacts(driver.initializeReply), init: initFacts(initOf(driver, from)?.frame),
        endStatus: end.status, isError: end.isError ?? null, marker: holds(textsBetween(driver, from), MARKERS.skill), toolCalls: toolCalls(driver, from),
        failureWords: failureWords(driver, from, foldersOf(ctx)),
      };
      return happened(common(driver, from, names, notes), end.index);
    },
  },
};

const PLANNED = ['image', 'big-image', 'steer-text', 'steer-tool', 'stop-held', 'skill'];

if (isMain(import.meta.url)) {
  await runSpike('m23-k2', (frame) => {
    if (frame.args.list) {
      for (const key of PLANNED) log(`claude  ${key.padEnd(10)} ${String(SCENARIOS[key].turns).padStart(2)} prompt(s)${SCENARIOS[key].atMost ? ' at most' : ''}  ${SCENARIOS[key].title}`);
      log(`total: ${PLANNED.reduce((sum, key) => sum + SCENARIOS[key].turns, 0)} prompts for one run of each, of the ten K2 may spend (C70)`);
      return 0;
    }
    const chosen = SCENARIOS[String(frame.args.scenario ?? '')];
    if (!chosen) { warn(`usage: node spikes/m23/k2.mjs --list | --scenario ${Object.keys(SCENARIOS).join('|')} --confirm-turns <n> [--again] [--path <executable>]`); return 1; }
    log(`K2: M16's launch as M20b leaves it, with ${EXTRA.join(' ')} and the reading mode's tools (${READING.join(', ')}) under default; background tasks off; the scratch configuration folder`);
    return runScenario('m23-k2', chosen, frame, OPTIONS);
  });
}
