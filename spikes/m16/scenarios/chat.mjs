// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// M16 spike K20: M10's scenarios T1, T3, T4 and T5 once more, under the arguments a chat session is
// launched with (C12, C13, C17, C19) and in the scratch configuration folder, and a prompt that
// names one of the CLI's commands (C69). These are the captures the replay fake replays for a chat
// session (C51): M10's own were launched with empty setting sources, `--strict-mcp-config` and
// `--no-session-persistence`, and never show the adapter the `init` a chat session's launch gets.
//
// Run once the maintainer had answered C14, C31 and C69, so as a session will be:
// `Agent` in the tool list, `--disable-slash-commands`, background tasks disabled (C40), and each
// prompt carrying an id of its own, which brings the `command_lifecycle` frames that bound its turn.
//
// The prompts are M10's, word for word: the fake chooses a capture by its prompt (C52).
//
// K22, added: K16's interrupt straight after the prompt, once more under these arguments.
// K16 ran before prompts carried an id, so its capture has no `command_lifecycle` frame, and C31
// takes a turn whose `init` no `started` precedes for one the CLI started by itself. Its prompt is
// its own, so that no other capture answers to it.
//
// K23 to K25, added (S15), under the same arguments and with an id on every prompt.
// K23 is K8's read outside every root once more: K8 ran before prompts carried an id, and its
// capture is the one the fake replays for a request from the CLI (C79). K24 resumes a session whose
// first turn was interrupted before it ran (C82). K25 resumes one whose process was ended as the
// app's process layer ends one, which no spike had done: each closed its processes in order (C86).
//
// K26 and K27, added for planning round 2. K26 times a turn under two hooks of the
// user's that run before a turn's `init` could: only a Stop hook had been traced (K18), and the
// `init` has a deadline (C15). K27 is K25's forced end during a turn instead of between two.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { typeKey } from '../../m10/claude/frames.mjs';
import { sleep } from '../../m10/lib/deadlines.mjs';
import { DENY_WORDS, didNotHappen, framesOf, happened, initOf, notRun, outline, ownText, resultOf, textWaits } from '../lib/common.mjs';

const UNKNOWN_MODEL = 'm10-no-such-model';

/** What C12 and C40 add to the launch since the three answers. */
const SETTLED = Object.freeze({ launch: { extra: ['--disable-slash-commands'] }, background: false });

/** K24's and K25's captures are each redacted together, so a session's id has one alias across its processes. */
const EARLY_RESUME_FAMILY = 'm16-early-resume';
const FORCED_RESUME_FAMILY = 'm16-forced-resume';
const FORCED_TURN_FAMILY = 'm16-forced-turn';

/** K26's hook: it notes its start and its end, and takes the seconds it is given. */
const SLOW_HOOK_SCRIPT = `// Written by fat-g's M16 spike (K26), and removed after its run: a hook that takes the seconds it is given.
import { appendFileSync } from 'node:fs';
const [, , label, seconds] = process.argv;
const log = new URL('./fatg-spike-slow-hook.log', import.meta.url);
appendFileSync(log, label + ' start ' + Date.now() + '\\n');
setTimeout(() => { appendFileSync(log, label + ' end ' + Date.now() + '\\n'); }, Number(seconds) * 1000);
`;
const SESSION_START_SECONDS = 4;
const PROMPT_SUBMIT_SECONDS = 7;

const msOf = (driver, index) => driver.session.frames.find((f) => f.index === index)?.ms ?? null;
/** A resume's launch: whether it opened, and what it wrote and how it exited when it did not (as K3 read them). */
const resumeOf = (attempt) => {
  const stayedUp = attempt.opened && !attempt.driver.tree?.rootExited;
  return { opened: attempt.opened, initializeAnswered: attempt.initializeAnswered, stayedUp, spawnToInitializeReplyMs: stayedUp ? msOf(attempt.driver, attempt.driver.sessionStart?.replyIndex) : null, exitCode: attempt.exit?.code ?? null, exitMs: attempt.exitMs, stdoutFrames: attempt.stdoutFrames, garbageLines: attempt.garbageLines, stderrBytes: attempt.stderrBytes };
};

const summary = (driver, from, uuid) => {
  const init = initOf(driver, from)?.frame ?? null;
  const result = resultOf(driver, from) ?? null;
  const lifecycle = driver.session.frames.filter((f) => f.dir === 'recv' && f.index >= from && typeKey(f.frame) === 'command_lifecycle');
  return {
    init: init ? { model: init.model ?? null, permissionMode: init.permissionMode ?? null, tools: (init.tools ?? []).filter((tool) => !String(tool).startsWith('mcp__')), mcpTools: (init.tools ?? []).filter((tool) => String(tool).startsWith('mcp__')).length, slashCommands: (init.slash_commands ?? []).length, skills: (init.skills ?? []).length } : null,
    result: result ? { subtype: result.frame.subtype ?? null, isError: result.frame.is_error === true, terminal: result.frame.terminal_reason ?? null, apiErrorStatus: result.frame.api_error_status ?? null, numTurns: result.frame.num_turns ?? null, hasOrigin: 'origin' in result.frame } : null,
    lifecycle: lifecycle.map((f) => ({ index: f.index, state: f.frame.state ?? null, namesOurId: f.frame.command_uuid === uuid, beforeInit: f.index < (initOf(driver, from)?.index ?? Infinity), afterResult: result ? f.index > result.index : null })),
    textWaits: textWaits(driver, from), requests: driver.requestsSeen.length, outline: outline(driver, from, { sent: [uuid] }),
  };
};

export const SCENARIOS = {
  'chat-t1': {
    id: 'm16-t1', name: 'm16-t1-basic', turns: 1,
    title: "K20: T1, a basic turn, under a chat session's arguments",
    successCondition: 'A read of sample.txt, then the end of the turn',
    async run(ctx) {
      if (!ctx.model) return notRun('no model chosen: run --scenario discover first');
      const driver = await ctx.open(SETTLED);
      const uuid = randomUUID();
      const from = await ctx.prompt(driver, 'Read the file sample.txt in the current folder, then tell me in one sentence what the cat is called.', { uuid });
      const end = await ctx.turnEnd(driver, from);
      await sleep(1_000);
      const reads = driver.events(from).filter((e) => e.kind === 'tool-call' && e.index < end.index);
      const notes = { endStatus: end.status, toolCalls: reads.map((e) => e.name), ...summary(driver, from, uuid) };
      if (reads.length === 0) return didNotHappen('the turn ended without a tool call', notes);
      return happened(notes, end.index);
    },
  },

  'chat-t3': {
    id: 'm16-t3', name: 'm16-t3-subagent', turns: 1,
    title: "K20: T3, a sub-agent, under a chat session's arguments",
    successCondition: "A worker's start and end, then the turn's end",
    async run(ctx) {
      if (!ctx.model) return notRun('no model chosen: run --scenario discover first');
      const driver = await ctx.open(SETTLED);
      const uuid = randomUUID();
      const from = await ctx.prompt(driver, 'Use the Agent tool to hand this small task to a sub-agent: read notes-3.txt and report its contents. Do not read the file yourself. When the sub-agent is done, tell me in one sentence what it found.', { uuid });
      const end = await ctx.turnEnd(driver, from);
      await sleep(1_000);
      const events = driver.events(from).filter((e) => e.index <= end.index);
      const start = events.find((e) => e.kind === 'worker-start');
      const stop = events.find((e) => e.kind === 'worker-end' && (!start || e.index > start.index));
      const started = driver.session.frames.filter((f) => f.dir === 'recv' && typeKey(f.frame) === 'system/task_started');
      const notes = { endStatus: end.status, workerBackgrounded: started.map((f) => f.frame.is_backgrounded ?? null), workerEvents: events.filter((e) => e.kind.startsWith('worker')).map((e) => ({ kind: e.kind, source: e.source ?? null, status: e.status ?? null })), toolCalls: events.filter((e) => e.kind === 'tool-call').map((e) => ({ name: e.name, worker: e.worker })), ...summary(driver, from, uuid) };
      if (!start || !stop) return didNotHappen(start ? 'a worker started but no end was seen before the turn ended' : 'no worker started', notes);
      return happened(notes, end.index);
    },
  },

  'chat-t4': {
    id: 'm16-t4', name: 'm16-t4-interrupt', turns: 1,
    title: "K20: T4, an interrupt at the first tool call, under a chat session's arguments",
    successCondition: "The turn's end in its interrupted state",
    async run(ctx) {
      if (!ctx.model) return notRun('no model chosen: run --scenario discover first');
      const driver = await ctx.open(SETTLED);
      const uuid = randomUUID();
      const from = await ctx.prompt(driver, 'Read notes-1.txt, notes-2.txt, notes-3.txt and notes-4.txt one at a time, in that order, and then summarise all four in one sentence.', { uuid });
      const first = await ctx.wait(driver, (e) => e.kind === 'tool-call' || e.kind === 'turn-end', from);
      if (first.kind === 'turn-end') return didNotHappen('the turn ended before any tool call', { endStatus: first.status, ...summary(driver, from, uuid) });
      const reply = await driver.interrupt();
      const end = await ctx.turnEnd(driver, first.index);
      await sleep(1_000);
      return happened({ interruptAccepted: reply.ok, firstTool: first.name, endStatus: end.status, terminalReason: end.terminalReason ?? null, isError: end.isError ?? null, ...summary(driver, from, uuid) }, end.index);
    },
  },

  'chat-t5': {
    id: 'm16-t5', name: 'm16-t5-error', turns: 1,
    title: "K20: T5, an unknown model id, under a chat session's arguments",
    successCondition: 'The error frame',
    async run(ctx) {
      // A model the catalog does not know has no effort levels, so none is named (C13).
      const attempt = await ctx.tryOpen({ ...SETTLED, launch: { ...SETTLED.launch, model: UNKNOWN_MODEL, effort: null } });
      const driver = attempt.driver;
      if (!attempt.opened) return happened({ failedAt: 'launch', promptSent: false, exitCode: attempt.exit?.code ?? null, stdoutFrames: attempt.stdoutFrames });
      const uuid = randomUUID();
      const from = await ctx.prompt(driver, 'Say hello in one word.', { uuid });
      const hit = await ctx.wait(driver, (e) => e.kind === 'error' || e.kind === 'turn-end', from);
      const end = hit.kind === 'turn-end' ? hit : await ctx.turnEnd(driver, from);
      await sleep(1_000);
      const failed = hit.kind === 'error' || hit.isError;
      const notes = { failedAt: 'turn', promptSent: true, via: hit.kind, source: hit.source ?? null, endStatus: end.status, ...summary(driver, from, uuid) };
      if (!failed) return didNotHappen('the turn ended normally on an unknown model', notes);
      return happened(notes, end.index);
    },
  },

  'chat-command': {
    id: 'm16-command', name: 'm16-command-refused', turns: 1,
    title: "K20: a prompt that names one of the CLI's commands, under a chat session's arguments",
    successCondition: "The CLI's own answer that the command is not available, and the turn's end, with no model called",
    async run(ctx) {
      if (!ctx.model) return notRun('no model chosen: run --scenario discover first');
      if (!ctx.state.modelB) return notRun('the CLI reported no second model to name');
      const driver = await ctx.open(SETTLED);
      const uuid = randomUUID();
      const from = await ctx.prompt(driver, `/model ${ctx.state.modelB}`, { uuid });
      const end = await ctx.turnEnd(driver, from);
      await sleep(1_000);
      const assistants = driver.session.frames.filter((f) => f.dir === 'recv' && f.index >= from && typeKey(f.frame) === 'assistant');
      const result = resultOf(driver, from)?.frame ?? {};
      const notes = {
        endStatus: end.status, answeredByTheCliItself: assistants.some((f) => f.frame.message?.model === '<synthetic>' && 'local_command_source' in f.frame), answeredByTheModel: assistants.some((f) => f.frame.message?.model !== '<synthetic>'),
        answerHasAnErrorField: assistants.some((f) => 'error' in f.frame), apiMs: result.duration_api_ms ?? null, modelStill: initOf(driver, from)?.frame.model ?? null, ...summary(driver, from, uuid),
      };
      if (!notes.answeredByTheCliItself || notes.answeredByTheModel) return didNotHappen('the prompt was not answered by the CLI itself', notes);
      return happened(notes, end.index);
    },
  },

  'chat-early-interrupt': {
    id: 'm16-chat-early-interrupt', name: 'm16-chat-early-interrupt', turns: 1,
    title: "K22: an interrupt sent straight after a prompt that carries an id, under a chat session's arguments",
    successCondition: 'The interrupt answered before the turn\'s `init`, and which `command_lifecycle` frames name the prompt around its `init` and `result`',
    async run(ctx) {
      if (!ctx.model) return notRun('no model chosen: run --scenario discover first');
      const driver = await ctx.open(SETTLED);
      const uuid = randomUUID();
      const from = await ctx.prompt(driver, 'Read notes-2.txt, then tell me in one sentence what it says.', { uuid });
      const initBefore = Boolean(initOf(driver, from));
      const reply = await driver.interrupt();
      const queued = reply.value?.still_queued;
      // What follows by itself: a `result`, with or without the turn's `init` before it, or nothing.
      let result = await ctx.maybeFrame(driver, (f) => typeKey(f) === 'result', from, 25_000);
      let second = null;
      if (!result && initOf(driver, from)) {
        // The prompt runs although the interrupt was answered: stop it as C28 would, after its `init`.
        const again = await driver.interrupt();
        second = { accepted: again.ok };
        result = await ctx.maybeFrame(driver, (f) => typeKey(f) === 'result', from, 30_000);
      }
      await sleep(3_000);
      const ms = (index) => driver.session.frames.find((f) => f.index === index)?.ms ?? null;
      const init = initOf(driver, from);
      const assistants = driver.session.frames.filter((f) => f.dir === 'recv' && f.index >= from && typeKey(f.frame) === 'assistant');
      const lifecycle = driver.session.frames.filter((f) => f.dir === 'recv' && f.index >= from && typeKey(f.frame) === 'command_lifecycle');
      const notes = {
        initHadArrivedBeforeTheInterruptWasSent: initBefore, interruptAccepted: reply.ok,
        stillQueued: Array.isArray(queued) ? queued.length : queued === undefined ? 'absent' : typeof queued,
        interruptReplyMsAfterThePrompt: ms(reply.index) - ms(from),
        initArrived: Boolean(init), initBeforeTheInterruptReply: init ? init.index < reply.index : null, initMsAfterThePrompt: init ? init.ms - ms(from) : null,
        resultArrived: Boolean(result), resultMsAfterThePrompt: result ? ms(result.index) - ms(from) : null,
        thePromptRan: assistants.length > 0, assistantFrames: assistants.length, secondInterrupt: second,
        // Each lifecycle frame by its state, with where it stands to the interrupt's reply, the `init` and the `result`.
        lifecycleOrder: lifecycle.map((f) => ({ state: f.frame.state ?? null, namesOurId: f.frame.command_uuid === uuid, msAfterThePrompt: f.ms - ms(from), afterTheInterruptReply: f.index > reply.index, beforeInit: init ? f.index < init.index : null, afterResult: result ? f.index > result.index : null })),
        ...summary(driver, from, uuid),
      };
      if (initBefore) return didNotHappen('the turn\'s `init` had arrived before the interrupt was sent', notes);
      return happened(notes, reply.index);
    },
  },

  'chat-request': {
    id: 'm16-chat-request', name: 'm16-chat-request', turns: 1,
    title: "K23: a read outside every root under a prompt that carries an id, denied, under a chat session's arguments",
    successCondition: "A `can_use_tool` request answered `deny`, the turn's end, and the `command_lifecycle` frames that name the prompt around them",
    async run(ctx) {
      if (!ctx.model) return notRun('no model chosen: run --scenario discover first');
      const driver = await ctx.open(SETTLED);
      const uuid = randomUUID();
      // K8's file, with no `--add-dir`. K8's own wording ("If you are not allowed to read it, say so")
      // was answered in run 1 with no tool call and so no request: the model said the file was
      // outside its working folder. These words ask for the call itself.
      const from = await ctx.prompt(driver, `Use the Read tool on the file ${path.join(ctx.other, 'second.txt')} now, even if you expect the read to be refused. Then tell me in one sentence what the file says, or that the read was refused.`, { uuid });
      const end = await ctx.turnEnd(driver, from);
      await sleep(1_000);
      const requests = framesOf(driver, 'control_request/can_use_tool', from);
      const answers = driver.session.frames.filter((f) => f.dir === 'send' && f.index >= from && typeKey(f.frame) === 'control_response');
      const lifecycle = framesOf(driver, 'command_lifecycle', from).filter((f) => f.frame.command_uuid === uuid);
      const started = lifecycle.find((f) => f.frame.state === 'started') ?? null;
      const closing = lifecycle.find((f) => !['queued', 'started'].includes(f.frame.state)) ?? null;
      const result = resultOf(driver, from);
      const toolResults = framesOf(driver, 'user', from).flatMap((f) => (Array.isArray(f.frame.message?.content) ? f.frame.message.content : []).filter((b) => b.type === 'tool_result'));
      const notes = {
        endStatus: end.status, isError: end.isError,
        // Each request: what asked and for which tool, never its input; and where it stands to the frames that bound the turn.
        requestsFromTheCli: requests.map(({ index, frame }) => ({
          index, tool: frame.request?.tool_name ?? null, worker: Boolean(frame.request?.agent_id), frameKeys: Object.keys(frame).sort(), keys: Object.keys(frame.request ?? {}).sort(),
          hasBlockedPath: typeof frame.request?.blocked_path === 'string', suggestions: (frame.request?.permission_suggestions ?? []).map((s) => s?.type ?? null),
          afterStarted: started ? index > started.index : null, afterInit: initOf(driver, from) ? index > initOf(driver, from).index : null, beforeResult: result ? index < result.index : null, beforeTheClosingFrame: closing ? index < closing.index : null,
        })),
        answersSent: answers.map(({ index, frame }) => {
          const asked = requests.find((r) => r.frame.request_id === frame.response?.request_id) ?? null;
          return { index, subtype: frame.response?.subtype ?? null, behavior: frame.response?.response?.behavior ?? null, theFixedWords: frame.response?.response?.message === DENY_WORDS, keys: Object.keys(frame.response?.response ?? {}).sort(), msAfterItsRequest: asked ? msOf(driver, index) - asked.ms : null };
        }),
        toolResults: toolResults.map((block) => ({ isError: block.is_error === true })),
        permissionDenials: Array.isArray(result?.frame.permission_denials) ? result.frame.permission_denials.length : null,
        closingState: closing?.frame.state ?? null, closingFrameAfterTheResult: closing && result ? closing.index > result.index : null, closingMsAfterTheResult: closing && result ? closing.ms - result.ms : null,
        lifecycleFramesNamingAnotherId: framesOf(driver, 'command_lifecycle', from).length - lifecycle.length,
        ...summary(driver, from, uuid),
      };
      if (requests.length === 0) return didNotHappen('the turn ended without a request from the CLI', notes);
      return happened(notes, end.index);
    },
  },

  'chat-early-resume': {
    id: 'm16-chat-early-resume', name: 'm16-early-resume', family: EARLY_RESUME_FAMILY, turns: 2, atMost: true,
    title: 'K24: a session whose first turn was interrupted before it ran, its process closed, then `--resume` of its id with a prompt',
    successCondition: 'Whether a session interrupted before its first turn ran is kept: its resume opening or not, and if it opens, a turn on it to its end',
    async run(ctx) {
      if (!ctx.model) return notRun('no model chosen: run --scenario discover first');
      const notes = {};
      // K22's steps, with a prompt of its own.
      const first = await ctx.open({ ...SETTLED, label: 'interrupted' });
      const firstId = randomUUID();
      const from = await ctx.prompt(first, 'Read notes-4.txt, then tell me in one sentence what it says.', { uuid: firstId });
      const initBefore = Boolean(initOf(first, from));
      const reply = await first.interrupt();
      let result = await ctx.maybeFrame(first, (f) => typeKey(f) === 'result', from, 25_000);
      let second = null;
      if (!result && initOf(first, from)) {
        const again = await first.interrupt();
        second = { accepted: again.ok };
        result = await ctx.maybeFrame(first, (f) => typeKey(f) === 'result', from, 30_000);
      }
      await sleep(3_000);
      const sessionId = initOf(first, from)?.frame.session_id ?? null;
      const ran = framesOf(first, 'assistant', from).length > 0;
      const { outline: outlineInterrupted, ...interrupted } = summary(first, from, firstId);
      notes.interrupted = { initHadArrivedBeforeTheInterruptWasSent: initBefore, interruptAccepted: reply.ok, initArrived: Boolean(sessionId), resultArrived: Boolean(result), thePromptRan: ran, secondInterrupt: second, ...interrupted };
      notes.outlineInterrupted = outlineInterrupted;
      const closed = await ctx.close(first);
      notes.interrupted.closed = { inOrder: closed.graceful && !closed.forced, exitCode: first.tree?.exitInfo?.code ?? null };
      if (!sessionId) return didNotHappen('the interrupted turn named no session to resume', notes);
      if (initBefore || ran || !result) return didNotHappen('the first turn was not interrupted before it ran', notes);

      const attempt = await ctx.tryOpen({ ...SETTLED, label: 'resumed', launch: { ...SETTLED.launch, resume: sessionId } });
      if (attempt.opened) await sleep(1_500);
      notes.resume = resumeOf(attempt);
      notes.kept = notes.resume.stayedUp;
      // Not kept is the finding too: the resume wrote what a missing session's writes (K3), and no second prompt goes out.
      if (!notes.kept) return happened(notes);
      const resumed = attempt.driver;
      const secondId = randomUUID();
      const from2 = await ctx.prompt(resumed, 'Without using any tool, tell me in one sentence which file I asked you to read just before this message, or say that this is my first message.', { uuid: secondId });
      const end = await ctx.turnEnd(resumed, from2);
      await sleep(1_000);
      const { outline: outlineResumed, ...turn } = summary(resumed, from2, secondId);
      notes.turn = { endStatus: end.status, isError: end.isError, initNamesTheResumedId: initOf(resumed, from2)?.frame.session_id === sessionId, sessionIdsSeen: resumed.sessionIds.length, knowsTheInterruptedPrompt: /notes-4/i.test(ownText(resumed, from2)), toolCalls: resumed.events(from2).filter((e) => e.kind === 'tool-call').length, ...turn };
      notes.outlineResumed = outlineResumed;
      return happened(notes);
    },
  },

  'chat-forced-resume': {
    id: 'm16-chat-forced-resume', name: 'm16-forced-resume', family: FORCED_RESUME_FAMILY, turns: 2, atMost: true,
    title: "K25: a session with one turn, its process ended by force as the app's process layer ends one, then `--resume` of its id with a prompt",
    successCondition: 'Whether a session resumes after its process was ended by force between turns: its resume opening or not, and if it opens, a turn on it with its context kept',
    async run(ctx) {
      if (!ctx.model) return notRun('no model chosen: run --scenario discover first');
      if (process.platform !== 'win32') return notRun('Windows only: elsewhere the process layer ends the input first, then signals the group');
      const notes = {};
      const first = await ctx.open({ ...SETTLED, label: 'first' });
      const firstId = randomUUID();
      const from = await ctx.prompt(first, 'Remember the word HARBOUR. Reply with the single word ok. Use no tools.', { uuid: firstId });
      const end = await ctx.turnEnd(first, from);
      // The turn's closing frame follows its `result` at once (K20). The end comes straight after
      // it: the earliest a close of the app's could come between two turns.
      const closing = await ctx.maybeFrame(first, (f) => typeKey(f) === 'command_lifecycle' && f.command_uuid === firstId && !['queued', 'started'].includes(f.state), from, 2_000);
      const sessionId = initOf(first, from)?.frame.session_id ?? null;
      const forced = await ctx.endByForce(first);
      const { outline: outlineFirst, ...firstTurn } = summary(first, from, firstId);
      notes.first = { endStatus: end.status, isError: end.isError, closingFrameArrived: Boolean(closing), forcedEnd: { ...forced, msAfterTheResult: forced.atMs - msOf(first, end.index) }, ...firstTurn };
      notes.outlineFirst = outlineFirst;
      if (end.isError || !sessionId) return didNotHappen("the first turn did not end completed, so there is no saved session with one turn", notes);
      if (!forced.taskkillOk || !forced.exited) return didNotHappen('the process was not ended by the forced end', notes);

      const attempt = await ctx.tryOpen({ ...SETTLED, label: 'resumed', launch: { ...SETTLED.launch, resume: sessionId } });
      if (attempt.opened) await sleep(1_500);
      notes.resume = resumeOf(attempt);
      notes.resumedAfterAForcedEnd = notes.resume.stayedUp;
      // Not resumed is the finding too, and no second prompt goes out.
      if (!notes.resumedAfterAForcedEnd) return happened(notes);
      const resumed = attempt.driver;
      const secondId = randomUUID();
      const from2 = await ctx.prompt(resumed, 'Which word did I ask you to remember? Reply with that word only. Use no tools.', { uuid: secondId });
      const end2 = await ctx.turnEnd(resumed, from2);
      await sleep(1_000);
      const { outline: outlineResumed, ...turn } = summary(resumed, from2, secondId);
      notes.turn = { endStatus: end2.status, isError: end2.isError, initNamesTheResumedId: initOf(resumed, from2)?.frame.session_id === sessionId, sessionIdsSeen: resumed.sessionIds.length, keptItsContext: /harbour/i.test(ownText(resumed, from2)), toolCalls: resumed.events(from2).filter((e) => e.kind === 'tool-call').length, ...turn };
      notes.outlineResumed = outlineResumed;

      // Once more with no prompt: a forced end a few seconds after a turn, and whether a resume then opens.
      await sleep(2_000);
      const forcedAgain = await ctx.endByForce(resumed);
      const again = await ctx.tryOpen({ ...SETTLED, label: 'again', launch: { ...SETTLED.launch, resume: sessionId } });
      if (again.opened) await sleep(1_500);
      notes.secondForcedEnd = { forcedEnd: { ...forcedAgain, msAfterTheResult: forcedAgain.atMs - msOf(resumed, end2.index) }, resume: resumeOf(again) };
      return happened(notes);
    },
  },

  'chat-hooks': {
    id: 'm16-chat-hooks', name: 'm16-chat-hooks', turns: 1,
    title: "K26: a turn under a SessionStart hook and a UserPromptSubmit hook that take several seconds each, under a chat session's arguments",
    successCondition: 'Both hooks timed against the `initialize` reply, the `started` frame and the `init`: which of them waits for which hook',
    async run(ctx) {
      if (!ctx.model) return notRun('no model chosen: run --scenario discover first');
      const script = ctx.writeConfig('fatg-spike-slow-hook.mjs', SLOW_HOOK_SCRIPT);
      const hookLog = ctx.expectWritten('fatg-spike-slow-hook.log');
      const command = (label, seconds) => ({ hooks: [{ type: 'command', command: `node ${script.split('\\').join('/')} ${label} ${seconds}`, timeout: 30 }] });
      // Two lengths, so that a wait can be told to its hook.
      ctx.writeConfig('settings.json', `${JSON.stringify({ hooks: { SessionStart: [command('session', SESSION_START_SECONDS)], UserPromptSubmit: [command('prompt', PROMPT_SUBMIT_SECONDS)] } }, null, 2)}\n`);
      const driver = await ctx.open(SETTLED);
      // The prompt is written straight after the `initialize` reply, as the app writes its first.
      const uuid = randomUUID();
      const from = await ctx.prompt(driver, 'Reply with the single word ok. Use no tools.', { uuid });
      const end = await ctx.turnEnd(driver, from);
      await sleep(1_000);
      const lines = existsSync(hookLog) ? readFileSync(hookLog, 'utf8').trim().split('\n').map((line) => line.split(' ')) : [];
      const stamps = (label, word) => lines.filter(([who, kind]) => who === label && kind === word).map(([, , stamp]) => Number(stamp) - driver.tree.spawnedAt);
      const hook = (label) => ({ ran: stamps(label, 'start').length, startsAtMs: stamps(label, 'start'), endsAtMs: stamps(label, 'end') });
      const session = hook('session');
      const prompt = hook('prompt');
      const lifecycle = framesOf(driver, 'command_lifecycle', from).filter((f) => f.frame.command_uuid === uuid);
      const at = { initializeReply: msOf(driver, driver.sessionStart.replyIndex), prompt: msOf(driver, from), queued: lifecycle.find((f) => f.frame.state === 'queued')?.ms ?? null, started: lifecycle.find((f) => f.frame.state === 'started')?.ms ?? null, init: initOf(driver, from)?.ms ?? null, firstAssistant: framesOf(driver, 'assistant', from)[0]?.ms ?? null, result: msOf(driver, end.index) };
      const after = (frameMs, ended) => (frameMs === null || ended.length === 0 ? null : frameMs >= ended[0]);
      const sincePrompt = (frameMs) => (frameMs === null ? null : frameMs - at.prompt);
      const notes = {
        endStatus: end.status, isError: end.isError, hookSeconds: { sessionStart: SESSION_START_SECONDS, userPromptSubmit: PROMPT_SUBMIT_SECONDS }, sessionStartHook: session, userPromptSubmitHook: prompt, atMs: at,
        msAfterThePrompt: { queued: sincePrompt(at.queued), started: sincePrompt(at.started), init: sincePrompt(at.init), firstAssistant: sincePrompt(at.firstAssistant), result: sincePrompt(at.result) },
        // What came only once a hook had ended: the wait a deadline would have to allow for.
        cameAfterTheSessionStartHookEnded: { initializeReply: after(at.initializeReply, session.endsAtMs), started: after(at.started, session.endsAtMs), init: after(at.init, session.endsAtMs), firstAssistant: after(at.firstAssistant, session.endsAtMs) },
        cameAfterTheUserPromptSubmitHookEnded: { queued: after(at.queued, prompt.endsAtMs), started: after(at.started, prompt.endsAtMs), init: after(at.init, prompt.endsAtMs), firstAssistant: after(at.firstAssistant, prompt.endsAtMs) },
        hookFrames: driver.session.frames.filter((f) => f.dir === 'recv' && typeKey(f.frame).startsWith('system/hook_')).map((f) => typeKey(f.frame)),
        ...summary(driver, from, uuid),
      };
      if (prompt.ran === 0) return didNotHappen('the UserPromptSubmit hook did not run', notes);
      return happened(notes, end.index);
    },
  },

  'chat-forced-turn': {
    id: 'm16-chat-forced-turn', name: 'm16-forced-turn', family: FORCED_TURN_FAMILY, turns: 2, atMost: true,
    title: "K27: a turn whose process is ended by force at its first tool call, as the app's process layer ends one, then `--resume` of its id with a prompt",
    successCondition: 'A process ended by force while its turn ran, then whether the resume opens and, if it does, how a turn on it ends and what it holds of the turn that was cut',
    async run(ctx) {
      if (!ctx.model) return notRun('no model chosen: run --scenario discover first');
      if (process.platform !== 'win32') return notRun('Windows only: elsewhere the process layer ends the input first, then signals the group');
      const notes = {};
      const first = await ctx.open({ ...SETTLED, label: 'cut' });
      const firstId = randomUUID();
      // Five reads, one at a time: the end takes over a second to land (K25), and the turn must still run then.
      const from = await ctx.prompt(first, 'Read notes-1.txt, notes-2.txt, notes-3.txt, notes-4.txt and sample.txt one at a time, in that order, and then tell me in one sentence each what they say.', { uuid: firstId });
      const hit = await ctx.wait(first, (e) => e.kind === 'tool-call' || e.kind === 'turn-end', from);
      const sessionId = initOf(first, from)?.frame.session_id ?? null;
      if (hit.kind === 'turn-end') {
        const { outline: outlineCut, ...cut } = summary(first, from, firstId);
        return didNotHappen('the turn ended before any tool call', { cut, outlineCut });
      }
      const forced = await ctx.endByForce(first);
      const { outline: outlineCut, ...cut } = summary(first, from, firstId);
      const afterTheEndWasStarted = first.session.frames.filter((f) => f.dir === 'recv' && f.ms >= forced.atMs).map((f) => typeKey(f.frame));
      notes.cut = { firstTool: hit.name, forcedEnd: { ...forced, msAfterTheFirstToolCall: forced.atMs - msOf(first, hit.index) }, toolCallsBeforeTheProcessWasGone: first.events(from).filter((e) => e.kind === 'tool-call').length, framesAfterTheEndWasStarted: afterTheEndWasStarted, resultArrived: Boolean(cut.result), ...cut };
      notes.outlineCut = outlineCut;
      if (cut.result) return didNotHappen('the turn ended before its process did', notes);
      if (!sessionId || !forced.taskkillOk || !forced.exited) return didNotHappen('the process was not ended by the forced end', notes);

      const attempt = await ctx.tryOpen({ ...SETTLED, label: 'resumed', launch: { ...SETTLED.launch, resume: sessionId } });
      if (attempt.opened) await sleep(1_500);
      notes.resume = resumeOf(attempt);
      notes.resumedAfterAForcedEndDuringATurn = notes.resume.stayedUp;
      // Not resumed is the finding too, and no second prompt goes out.
      if (!notes.resumedAfterAForcedEndDuringATurn) return happened(notes);
      const resumed = attempt.driver;
      const secondId = randomUUID();
      const from2 = await ctx.prompt(resumed, 'Without using any tool, tell me in one sentence which files I asked you to read just before this message, and how many of them you had read.', { uuid: secondId });
      const end = await ctx.turnEnd(resumed, from2);
      await sleep(1_000);
      const { outline: outlineResumed, ...turn } = summary(resumed, from2, secondId);
      // A turn that fails here is the finding as much as one that completes: the conversation was left with a call that has no result.
      notes.turn = { endStatus: end.status, isError: end.isError, initNamesTheResumedId: initOf(resumed, from2)?.frame.session_id === sessionId, sessionIdsSeen: resumed.sessionIds.length, knowsThePromptThatWasCut: /notes-1/i.test(ownText(resumed, from2)), toolCalls: resumed.events(from2).filter((e) => e.kind === 'tool-call').length, ...turn };
      notes.outlineResumed = outlineResumed;
      return happened(notes);
    },
  },
};
