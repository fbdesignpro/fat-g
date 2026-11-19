// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// M16 spikes K11, K12, K13, K16, K17, K18 and K19: what a turn can do that M10's traces did not
// show. An interrupt while a worker runs; a worker in the background, with and without the variable
// that disables it; a read large enough to show how long a frame gets; an interrupt before the
// turn's `init`; a turn the CLI starts by itself; a turn under a slow Stop hook; and prompts that
// name the CLI's own commands.
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { typeKey } from '../../m10/claude/frames.mjs';
import { sleep } from '../../m10/lib/deadlines.mjs';
import { didNotHappen, framesOf, happened, initOf, notRun, outline, ownText, textWaits } from '../lib/common.mjs';

const blocksOf = (frame) => (Array.isArray(frame.message?.content) ? frame.message.content : []);
const msOf = (driver, index) => driver.session.frames.find((f) => f.index === index)?.ms ?? null;
const CLOSING = ['completed', 'failed', 'killed', 'stopped', 'cancelled', 'canceled', 'interrupted'];

/** The frames that close a worker, in the order they came. */
const closingFrames = (driver, from) => driver.session.frames.filter((f) => f.dir === 'recv' && f.index >= from && ((typeKey(f.frame) === 'system/task_updated' && CLOSING.includes(f.frame.patch?.status)) || typeKey(f.frame) === 'system/task_notification'))
  .map((f) => ({ index: f.index, ms: f.ms, type: typeKey(f.frame), status: f.frame.status ?? f.frame.patch?.status ?? null, task: f.frame.task_id }));

const resultRows = (driver, from) => framesOf(driver, 'result', from).map(({ index, ms, frame }) => ({ index, ms, subtype: frame.subtype ?? null, isError: frame.is_error === true, terminal: frame.terminal_reason ?? null, numTurns: frame.num_turns ?? null, resultIndex: frame.result_index ?? null, queuedTurnCount: frame.queued_turn_count ?? null }));

/** Waits until every worker started from `from` has a closing frame, a quarter second at a time. */
async function followWorkers(driver, from, ms) {
  const until = Date.now() + ms;
  const done = () => {
    const started = new Set(framesOf(driver, 'system/task_started', from).map((f) => f.frame.task_id));
    const closed = new Set(closingFrames(driver, from).map((row) => row.task));
    return started.size > 0 && [...started].every((task) => closed.has(task));
  };
  while (Date.now() < until) {
    if (done()) return true;
    if (driver.tree?.rootExited) return false;
    await sleep(250);
  }
  return done();
}

const LONG_WORKER_TASK = 'read notes-1.txt, notes-2.txt, notes-3.txt, notes-4.txt and sample.txt one at a time, in that order, then read each of the five a second time in the same order, then report every sentence found';
const BACKGROUND_PROMPT = `Use the Agent tool with run_in_background set to true to start a sub-agent on this task: ${LONG_WORKER_TASK}. Do not wait for the sub-agent and do not read the files yourself: as soon as it has started, end your turn by telling me in one sentence that it is working in the background.`;

/** K12: one run with background tasks as the CLI has them, one with the variable of C40 set. */
function background({ id, name, title, disabled }) {
  return {
    id, name, turns: 1, title,
    successCondition: "A worker asked for in the background, the turn's end, then every frame until that worker has ended and the session is quiet",
    async run(ctx) {
      if (!ctx.model) return notRun('no model chosen: run --scenario discover first');
      const driver = await ctx.open({ background: !disabled });
      const from = await ctx.prompt(driver, BACKGROUND_PROMPT);
      const end = await ctx.turnEnd(driver, from);
      const started = framesOf(driver, 'system/task_started', from);
      const closedBefore = closingFrames(driver, from).filter((row) => row.index < end.index);
      const base = {
        variableSet: disabled, endStatus: end.status, firstResult: resultRows(driver, from)[0] ?? null,
        workersStarted: started.map((f) => ({ index: f.index, backgrounded: f.frame.is_backgrounded ?? null, taskType: f.frame.task_type ?? null })),
        agentCalls: framesOf(driver, 'assistant', from).flatMap((f) => blocksOf(f.frame)).filter((b) => b.type === 'tool_use' && b.name === 'Agent').map((b) => ({ askedForBackground: b.input?.run_in_background ?? null })),
        workerClosedBeforeTheTurnEnded: closedBefore.length > 0,
      };
      if (started.length === 0) return didNotHappen('no worker started', { ...base, outline: outline(driver, from) });
      // The turn is over. Follow the worker to its end, then whatever the CLI starts by itself.
      const followed = closedBefore.length > 0 ? true : await followWorkers(driver, from, 170_000);
      const closing = closingFrames(driver, from);
      const lastClose = closing.at(-1)?.index ?? end.index;
      const selfStarted = await ctx.maybeFrame(driver, (f) => typeKey(f) === 'result', Math.max(lastClose, end.index + 1), 40_000);
      await sleep(4_000);
      const after = driver.session.frames.filter((f) => f.dir === 'recv' && f.index > end.index);
      const count = (type) => after.filter((f) => typeKey(f.frame) === type).length;
      const notes = {
        ...base, workerEnded: followed, closingFrames: closing.map(({ index, type, status }) => ({ index, type, status, afterTheTurnEnded: index > end.index })),
        workerOutlivedItsTurnByMs: closing.length && closing[0].index > end.index ? closing[0].ms - msOf(driver, end.index) : null,
        afterTheTurnEnded: { inits: count('system/init'), assistants: count('assistant'), results: count('result'), sessionStateChanged: count('system/session_state_changed'), backgroundTasksChanged: count('system/background_tasks_changed'), userFrames: after.filter((f) => typeKey(f.frame) === 'user' && f.frame.parent_tool_use_id == null).map((f) => ({ index: f.index, keys: Object.keys(f.frame).sort() })) },
        aTurnTheCliStartedByItself: Boolean(selfStarted), results: resultRows(driver, from), textWaits: textWaits(driver, from), outline: outline(driver, from),
      };
      if (disabled) return happened(notes, end.index);
      if (closedBefore.length > 0) return didNotHappen('the worker ended before its turn did', notes);
      return happened(notes, end.index);
    },
  };
}

/** A PNG of noise, which does not compress: `side` pixels square is about 3 × side² bytes. */
function noisePng(side) {
  const crc = (buffer) => { let c = 0xffffffff; for (const byte of buffer) { c ^= byte; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; };
  const chunk = (name, bytes) => { const tag = Buffer.from(name); const out = Buffer.alloc(12 + bytes.length); out.writeUInt32BE(bytes.length); tag.copy(out, 4); bytes.copy(out, 8); out.writeUInt32BE(crc(Buffer.concat([tag, bytes])), out.length - 4); return out; };
  const header = Buffer.alloc(13); header.writeUInt32BE(side); header.writeUInt32BE(side, 4); header[8] = 8; header[9] = 2;
  const row = side * 3 + 1;
  const pixels = randomBytes(side * row);
  for (let y = 0; y < side; y++) pixels[y * row] = 0;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels, { level: 1 })), chunk('IEND', Buffer.alloc(0))]);
}

const BIG_TEXT = Array.from({ length: 600 }, (_, i) => `Line ${String(i + 1).padStart(4, '0')}: the tide gauge was read at the quay steps.`).join('\n') + '\n';

const HOOK_SCRIPT = `// Written by fat-g's M16 spike (K18), and removed after its run: a Stop hook that takes six seconds.
import { appendFileSync } from 'node:fs';
const log = new URL('./fatg-spike-stop-hook.log', import.meta.url);
appendFileSync(log, 'start ' + Date.now() + '\\n');
setTimeout(() => { appendFileSync(log, 'end ' + Date.now() + '\\n'); }, 6000);
`;

const SKILL = 'fatg-spike-skill';
const SKILL_FILE = `---
name: ${SKILL}
description: A test skill written by fat-g's spike. When it runs, the reply is the single word PINEAPPLE.
---
Reply with the single word PINEAPPLE and nothing else. Use no tools.
`;

export const SCENARIOS = {
  'worker-interrupt': {
    id: 'm16-worker-interrupt', name: 'm16-worker-interrupt', turns: 1,
    title: 'K11: an interrupt while a worker runs',
    successCondition: "A worker's start, an interrupt while it runs, the turn's end, and the worker's closing frames in the order they came",
    async run(ctx) {
      if (!ctx.model) return notRun('no model chosen: run --scenario discover first');
      const driver = await ctx.open();
      // The first run left `run_in_background` out, and the CLI then starts the worker in the
      // background and ends the turn at once: the prompt names the foreground outright.
      const from = await ctx.prompt(driver, `Use the Agent tool with run_in_background set to false to hand this task to a sub-agent: ${LONG_WORKER_TASK}. Do not read the files yourself. Wait for the sub-agent, and when it is done tell me in one sentence what it found.`);
      const first = await ctx.wait(driver, (e) => e.kind === 'worker-start' || e.kind === 'turn-end', from);
      if (first.kind === 'turn-end') return didNotHappen('the turn ended before any worker started', { endStatus: first.status, outline: outline(driver, from) });
      // Let the worker get under way: its first tool call, or three seconds.
      await Promise.race([ctx.wait(driver, (e) => (e.kind === 'tool-call' && e.worker) || e.kind === 'turn-end', first.index).catch(() => null), sleep(3_000)]);
      const closedFirst = closingFrames(driver, from).length > 0;
      const turnOverFirst = framesOf(driver, 'result', from).length > 0;
      const interruptAt = driver.nextIndex;
      const reply = await driver.interrupt();
      if (turnOverFirst) {
        // The turn had ended with its worker still running: the interrupt then finds workers alone.
        await sleep(8_000);
        return didNotHappen('the turn had ended before the interrupt went out, its worker still running', {
          interruptAccepted: reply.ok, backgrounded: framesOf(driver, 'system/task_started', from).map((f) => f.frame.is_backgrounded ?? null),
          closingFrames: closingFrames(driver, from).map(({ index, type, status }) => ({ index, type, status })), resultsAfterTheInterrupt: framesOf(driver, 'result', interruptAt).length, outline: outline(driver, from),
        });
      }
      const end = await ctx.turnEnd(driver, first.index);
      // What still arrives once the turn is over.
      await sleep(8_000);
      const closing = closingFrames(driver, from);
      const after = driver.session.frames.filter((f) => f.dir === 'recv' && f.index > end.index);
      const notes = {
        interruptAccepted: reply.ok, stillQueued: Array.isArray(reply.value?.still_queued) ? reply.value.still_queued.length : null, endStatus: end.status, isError: end.isError, terminal: end.terminalReason ?? null,
        workerHadEndedBeforeTheInterrupt: closedFirst, interruptSentAtIndex: interruptAt, resultIndex: end.index,
        closingFrames: closing.map(({ index, type, status }) => ({ index, type, status, afterTheResult: index > end.index, msFromTheResult: msOf(driver, index) - msOf(driver, end.index) })),
        framesAfterTheResult: after.map((f) => typeKey(f.frame)), workerFramesAfterTheResult: after.filter((f) => f.frame.parent_tool_use_id != null || typeKey(f.frame).startsWith('system/task_')).length,
        outline: outline(driver, interruptAt - 4),
      };
      if (closedFirst) return didNotHappen('the worker had ended before the interrupt went out', notes);
      return happened(notes, end.index);
    },
  },

  background: background({ id: 'm16-background', name: 'm16-background', title: 'K12: a worker started in the background and still running when its turn ends', disabled: false }),
  'background-disabled': background({ id: 'm16-background-disabled', name: 'm16-background-disabled', title: 'K12: the same request with CLAUDE_CODE_DISABLE_BACKGROUND_TASKS set', disabled: true }),

  'large-read': {
    id: 'm16-large-read', name: 'm16-large-read', turns: 1,
    files: { 'big.txt': BIG_TEXT, 'picture.png': noisePng(600) },
    title: 'K13: a read large enough to show how long a frame gets',
    successCondition: 'A read of a 36 kB text file and of a 1 MB picture, with the size of every frame they made',
    async run(ctx) {
      if (!ctx.model) return notRun('no model chosen: run --scenario discover first');
      const driver = await ctx.open();
      const from = await ctx.prompt(driver, 'Read big.txt in the current folder in full, then read picture.png in the current folder, then tell me in one sentence how many numbered lines big.txt has and in one more what the picture shows.');
      const end = await ctx.turnEnd(driver, from);
      const targets = new Map();
      for (const { frame } of framesOf(driver, 'assistant', from)) for (const block of blocksOf(frame)) if (block.type === 'tool_use') targets.set(block.id, `${block.name} ${/big\.txt/i.test(String(block.input?.file_path)) ? 'big.txt' : /picture\.png/i.test(String(block.input?.file_path)) ? 'picture.png' : 'other'}`);
      const results = framesOf(driver, 'user', from).flatMap((f) => blocksOf(f.frame).filter((b) => b.type === 'tool_result').map((b) => ({ index: f.index, answers: targets.get(b.tool_use_id) ?? null, error: b.is_error === true, frameBytes: driver.sizes.get(f.frame) ?? null, carriesToolUseResult: 'tool_use_result' in f.frame })));
      const notes = {
        endStatus: end.status, fileBytes: { 'big.txt': Buffer.byteLength(BIG_TEXT), 'picture.png': readFileSync(`${ctx.project}/picture.png`).length },
        toolResults: results, largestByType: driver.largestByType(), stringsOver32KiB: driver.longStrings, overOneMiB: driver.frameBytes.filter((f) => f.bytes > 1024 * 1024), outline: outline(driver, from),
      };
      if (results.length === 0) return didNotHappen('the turn ended without a read', notes);
      return happened(notes, end.index);
    },
  },

  'early-interrupt': {
    id: 'm16-early-interrupt', name: 'm16-early-interrupt', turns: 1,
    title: "K16: an interrupt sent after the prompt is written and before its `init`",
    successCondition: 'The interrupt answered, what `still_queued` holds, and whether the prompt still runs',
    async run(ctx) {
      if (!ctx.model) return notRun('no model chosen: run --scenario discover first');
      const driver = await ctx.open();
      const from = await ctx.prompt(driver, 'Read notes-1.txt, notes-2.txt, notes-3.txt and notes-4.txt one at a time, in that order, and then summarise all four in one sentence.');
      const initBefore = Boolean(initOf(driver, from));
      const reply = await driver.interrupt();
      const queued = reply.value?.still_queued;
      // What follows by itself: the turn's `init` (the prompt runs all the same), a `result`, or nothing.
      const next = await ctx.maybeFrame(driver, (f) => ['system/init', 'result'].includes(typeKey(f)), from, 25_000);
      let second = null;
      if (next && typeKey(next.frame) === 'system/init' && next.index > reply.index) {
        // The prompt runs although the interrupt was answered: stop it as C28 would, at its `init`.
        const done = await ctx.maybeFrame(driver, (f) => typeKey(f) === 'result', next.index, 3_000);
        if (!done) { const again = await driver.interrupt(); second = { accepted: again.ok, stillQueued: Array.isArray(again.value?.still_queued) ? again.value.still_queued.length : null }; }
        await ctx.turnEnd(driver, next.index);
      } else if (next && typeKey(next.frame) === 'system/init') {
        await ctx.maybeFrame(driver, (f) => typeKey(f) === 'result', next.index, 30_000);
      }
      await sleep(3_000);
      const init = initOf(driver, from);
      const notes = {
        initHadArrivedBeforeTheInterruptWasSent: initBefore, interruptAccepted: reply.ok, replyKeys: reply.ok ? Object.keys(reply.value ?? {}).sort() : null,
        stillQueued: Array.isArray(queued) ? { entries: queued.length, entryTypes: [...new Set(queued.map((entry) => typeof entry))], entryKeys: [...new Set(queued.flatMap((entry) => (entry && typeof entry === 'object' ? Object.keys(entry) : [])))].sort() } : queued === undefined ? 'absent' : typeof queued,
        interruptReplyMsAfterThePrompt: msOf(driver, reply.index) - msOf(driver, from),
        initArrived: Boolean(init), initBeforeTheInterruptReply: init ? init.index < reply.index : null, initMsAfterThePrompt: init ? init.ms - msOf(driver, from) : null,
        thePromptRan: framesOf(driver, 'assistant', from).length > 0, assistantFrames: framesOf(driver, 'assistant', from).length, toolCalls: driver.events(from).filter((e) => e.kind === 'tool-call').length,
        secondInterrupt: second, results: resultRows(driver, from), outline: outline(driver, from),
      };
      return happened(notes, reply.index);
    },
  },

  'self-turn': {
    id: 'm16-self-turn', name: 'm16-self-turn', turns: 2,
    title: 'K17: what marks a turn the CLI starts by itself, with `--replay-user-messages` and a prompt written meanwhile',
    successCondition: "A background worker, a prompt written while it runs, then the frames of whatever the CLI starts once the worker ends",
    async run(ctx) {
      if (!ctx.model) return notRun('no model chosen: run --scenario discover first');
      const first = randomUUID();
      const second = randomUUID();
      const driver = await ctx.open({ launch: { replay: true } });
      const from = await ctx.prompt(driver, BACKGROUND_PROMPT, { uuid: first });
      const end1 = await ctx.turnEnd(driver, from);
      const started = framesOf(driver, 'system/task_started', from);
      const closedBefore = closingFrames(driver, from).filter((row) => row.index < end1.index);
      if (started.length === 0 || closedBefore.length > 0) return didNotHappen(started.length === 0 ? 'no worker started' : 'the worker ended before its turn did', { results: resultRows(driver, from), outline: outline(driver, from, { sent: [first] }) });
      // A prompt of ours while the worker still runs.
      const from2 = await ctx.prompt(driver, 'Reply with the single word ok. Use no tools.', { uuid: second });
      const end2 = await ctx.turnEnd(driver, from2);
      const followed = await followWorkers(driver, from, 170_000);
      const closing = closingFrames(driver, from);
      const lastClose = closing.at(-1)?.index ?? end2.index;
      const settled = Math.max(lastClose, end2.index + 1);
      const selfStarted = await ctx.maybeFrame(driver, (f) => typeKey(f) === 'result', settled, 40_000);
      await sleep(4_000);
      const users = framesOf(driver, 'user', from).filter((f) => f.frame.parent_tool_use_id == null);
      const inits = framesOf(driver, 'system/init', from);
      const notes = {
        workerEnded: followed, workerClosedDuringOurSecondTurn: closing.some((row) => row.index > from2 && row.index < end2.index), aTurnTheCliStartedByItself: Boolean(selfStarted),
        ourPromptsAtIndex: [from, from2], inits: inits.map((f) => ({ index: f.index, ms: f.ms, sameSession: f.frame.session_id === inits[0].frame.session_id })), results: resultRows(driver, from),
        closingFrames: closing.map(({ index, type, status }) => ({ index, type, status })),
        userFramesOfTheSession: users.map((f) => ({ index: f.index, ours: f.frame.uuid === first ? 'first' : f.frame.uuid === second ? 'second' : null, isReplay: f.frame.isReplay ?? null, isSynthetic: f.frame.isSynthetic ?? null, content: typeof f.frame.message?.content === 'string' ? 'text' : blocksOf(f.frame).map((b) => b.type), keys: Object.keys(f.frame).sort() })),
        resultKeys: framesOf(driver, 'result', from).length ? Object.keys(framesOf(driver, 'result', from).at(-1).frame).sort() : null,
        textWaits: textWaits(driver, from), outline: outline(driver, from, { sent: [first, second] }),
      };
      return happened(notes, end2.index);
    },
  },

  'stop-hook': {
    id: 'm16-stop-hook', name: 'm16-stop-hook', turns: 1,
    title: 'K18: a turn under a Stop hook that takes six seconds',
    successCondition: "A turn with a commentary and an answer under the hook, with the time from each text to the frame that settles it",
    async run(ctx) {
      if (!ctx.model) return notRun('no model chosen: run --scenario discover first');
      const script = ctx.writeConfig('fatg-spike-stop-hook.mjs', HOOK_SCRIPT);
      const hookLog = ctx.expectWritten('fatg-spike-stop-hook.log');
      ctx.writeConfig('settings.json', `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `node ${script.split('\\').join('/')}`, timeout: 30 }] }] } }, null, 2)}\n`);
      const driver = await ctx.open();
      const from = await ctx.prompt(driver, 'Read the file sample.txt in the current folder, then tell me in one sentence what the cat is called.');
      const end = await ctx.turnEnd(driver, from);
      await sleep(8_000);
      const lines = existsSync(hookLog) ? readFileSync(hookLog, 'utf8').trim().split('\n').map((line) => line.split(' ')) : [];
      const at = (word) => lines.filter(([kind]) => kind === word).map(([, stamp]) => Number(stamp) - driver.tree.spawnedAt);
      const waits = textWaits(driver, from);
      const finalText = waits.at(-1) ?? null;
      const hookFrames = driver.session.frames.filter((f) => f.dir === 'recv' && f.index >= from && typeKey(f.frame).startsWith('system/hook_'));
      const notes = {
        endStatus: end.status, hookRan: at('start').length, hookStartsAtMs: at('start'), hookEndsAtMs: at('end'), resultAtMs: msOf(driver, end.index),
        finalTextAtMs: finalText ? msOf(driver, finalText.index) : null, finalTextWaitedForItsResultMs: finalText?.settledBy === 'result' ? finalText.waitMs : null,
        resultCameAfterTheHookEnded: at('end').length ? msOf(driver, end.index) >= at('end')[0] : null, textWaits: waits, hookFrames: hookFrames.map((f) => typeKey(f.frame)),
        framesAfterTheResult: driver.session.frames.filter((f) => f.dir === 'recv' && f.index > end.index).map((f) => typeKey(f.frame)), outline: outline(driver, from),
      };
      if (at('start').length === 0) return didNotHappen('the Stop hook did not run', notes);
      return happened(notes, end.index);
    },
  },

  'commands-disabled': {
    id: 'm16-commands-disabled', name: 'm16-commands-disabled', turns: 3,
    title: 'K19: the same prompts under `--disable-slash-commands`',
    successCondition: "Three prompts naming a command, a skill and /clear, with whether the CLI still runs them or sends them to the model as text",
    async run(ctx) {
      if (!ctx.model) return notRun('no model chosen: run --scenario discover first');
      ctx.writeConfig(`skills/${SKILL}/SKILL.md`, SKILL_FILE);
      const driver = await ctx.open({ launch: { extra: ['--disable-slash-commands'] } });
      const reply = driver.initializeReply ?? {};
      const steps = [];
      let firstSession = null;
      const step = async (label, text) => {
        const from = await ctx.prompt(driver, text);
        const result = await ctx.maybeFrame(driver, (f) => typeKey(f) === 'result', from, 60_000);
        await sleep(1_500);
        const received = driver.session.frames.filter((f) => f.dir === 'recv' && f.index >= from);
        const init = initOf(driver, from)?.frame ?? null;
        firstSession ??= init?.session_id ?? null;
        const assistants = received.filter((f) => typeKey(f.frame) === 'assistant');
        steps.push({
          label, gotAResult: Boolean(result), types: Object.entries(received.reduce((counts, f) => { const key = typeKey(f.frame); counts[key] = (counts[key] ?? 0) + 1; return counts; }, {})),
          init: init ? { model: init.model ?? null, sameSessionAsTheFirst: init.session_id === firstSession, slashCommands: (init.slash_commands ?? []).length, skills: (init.skills ?? []).length } : null,
          result: result ? { subtype: result.frame.subtype ?? null, isError: result.frame.is_error === true, numTurns: result.frame.num_turns ?? null, apiMs: result.frame.duration_api_ms ?? null } : null,
          answeredByTheCliItself: assistants.some((f) => f.frame.message?.model === '<synthetic>' || 'local_command_source' in f.frame), answeredByTheModel: assistants.some((f) => f.frame.message?.model !== '<synthetic>'),
          text: ownText(driver, from),
        });
        return steps.at(-1);
      };
      await step('/model', `/model ${ctx.state.modelB}`);
      const skill = await step("a skill's name", `/${SKILL}`);
      await step('/clear', '/clear');
      return happened({
        commandsInTheInitializeReply: (reply.commands ?? []).length, steps: steps.map(({ text, ...row }) => row), theSkillRan: /pineapple/i.test(skill.text),
        sessionIdsSeen: driver.sessionIds.length, conversationResets: framesOf(driver, 'conversation_reset', 0).length, outline: outline(driver, 0),
      });
    },
  },

  commands: {
    id: 'm16-commands', name: 'm16-commands', turns: 6,
    title: "K19: prompts that are the CLI's own commands: /model, a skill's name, /compact and /clear",
    successCondition: 'Each prompt with what the CLI did, and what the `init` after it reports',
    async run(ctx) {
      if (!ctx.model) return notRun('no model chosen: run --scenario discover first');
      if (!ctx.state.modelB) return notRun('the CLI reported no second model to switch to');
      ctx.writeConfig(`skills/${SKILL}/SKILL.md`, SKILL_FILE);
      const settingsAtLaunch = ctx.settingsNow();
      const driver = await ctx.open();
      const reply = driver.initializeReply ?? {};
      const commandNames = (reply.commands ?? []).map((c) => (typeof c === 'string' ? c : c?.name));
      const steps = [];
      let firstSession = null;
      const step = async (label, text, wait = 60_000) => {
        const from = await ctx.prompt(driver, text);
        const result = await ctx.maybeFrame(driver, (f) => typeKey(f) === 'result', from, wait);
        await sleep(1_500);
        const received = driver.session.frames.filter((f) => f.dir === 'recv' && f.index >= from);
        const init = initOf(driver, from)?.frame ?? null;
        firstSession ??= init?.session_id ?? null;
        const row = {
          label, gotAResult: Boolean(result), types: Object.entries(received.reduce((counts, f) => { const key = typeKey(f.frame); counts[key] = (counts[key] ?? 0) + 1; return counts; }, {})),
          init: init ? { model: init.model ?? null, permissionMode: init.permissionMode ?? null, sameSessionAsTheFirst: init.session_id === firstSession } : null,
          result: result ? { subtype: result.frame.subtype ?? null, isError: result.frame.is_error === true, numTurns: result.frame.num_turns ?? null, resultChars: typeof result.frame.result === 'string' ? result.frame.result.length : null, modelsUsed: Object.keys(result.frame.modelUsage ?? {}).length, apiMs: result.frame.duration_api_ms ?? null } : null,
          assistantFrames: received.filter((f) => typeKey(f.frame) === 'assistant').length, statusFrames: received.filter((f) => typeKey(f.frame) === 'system/status').map((f) => f.frame.status ?? null),
          text: ownText(driver, from),
        };
        steps.push(row);
        return row;
      };
      await step('a first turn', 'Remember the word LANTERN. Reply with the single word ok. Use no tools.');
      await step('/model', `/model ${ctx.state.modelB}`);
      const skill = await step("a skill's name", `/${SKILL}`);
      await step('/compact', '/compact', 120_000);
      await step('/clear', '/clear');
      const last = await step('a turn after them', 'Which word did I ask you to remember earlier in this conversation? Reply with that word only, or with the single word unknown. Use no tools.');
      const settingsNow = ctx.settingsNow();
      const notes = {
        commandsListed: { model: commandNames.includes('model'), clear: commandNames.includes('clear'), compact: commandNames.includes('compact'), theSkill: commandNames.includes(SKILL) },
        skillListedInInit: (initOf(driver, 0)?.frame.skills ?? []).includes(SKILL), skillInSlashCommands: (initOf(driver, 0)?.frame.slash_commands ?? []).includes(SKILL),
        modelLaunchedWith: ctx.model, modelAskedFor: ctx.state.modelB,
        steps: steps.map(({ text, ...row }) => row),
        theSkillRan: /pineapple/i.test(skill.text), theWordSurvived: /lantern/i.test(last.text), saidUnknown: /unknown/i.test(last.text),
        sessionIdsSeen: driver.sessionIds.length, settingsFilesUnchanged: JSON.stringify(settingsAtLaunch) === JSON.stringify(settingsNow), settingsFiles: settingsNow,
        outline: outline(driver, 0),
      };
      return happened(notes);
    },
  },
};
