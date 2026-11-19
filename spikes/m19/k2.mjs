// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// M19 spike K2 (docs/planning/_archive/M19-spec-sheet.md; C11 to C13, C55, C60): Claude's installed CLI under
// M16's launch arguments with `--include-partial-messages` added, in M16's scratch configuration
// folder. Eight prompts at most: six scenarios of one, and one of two.
//
//   node spikes/m19/k2.mjs --list
//   node spikes/m19/k2.mjs --scenario <id> --confirm-turns <n> [--again]
//
// Without --confirm-turns equal to the scenario's count it prints its plan and launches nothing
// (S8). One invocation is one run; at most three runs per scenario (M10's ledger, under
// spikes/output/m19). The model and effort are the ones M16's `discover` scenario left in
// spikes/output/m16/state.json; sessions are saved in the scratch configuration folder, as M16's.
//
// The prompts of the first five are K20's, word for word: the fake replays this capture for that
// prompt when it is started with the new argument (C55). What a run records is never a text: for
// each reply, the order and identities of its `stream_event` frames and its `assistant` frames,
// the sizes and rate of its text deltas, a worker's and a synthetic reply's frames, and what an
// interrupt and a forced end leave.
import { randomUUID } from 'node:crypto';
import { typeKey } from '../m10/claude/frames.mjs';
import { sleep } from '../m10/lib/deadlines.mjs';
import { isMain } from '../m10/lib/paths.mjs';
import { log, runSpike, warn } from '../m10/lib/spike.mjs';
import { didNotHappen, framesOf, happened, initOf, notRun, outline, ownText, resultOf, runScenario } from '../m16/lib/common.mjs';
import { M19ClaudeDriver, M19_DIR, OMITTED_CLAUDE, deltaFacts, received, sizes } from './lib/common.mjs';

const OPTIONS = { dir: M19_DIR, milestone: 'M19', Driver: M19ClaudeDriver, omitted: OMITTED_CLAUDE };
/** M16's settled launch (C12, C40, C69), with the one argument this milestone adds (C9). */
const EXTRA = ['--disable-slash-commands', '--include-partial-messages'];
const SETTLED = Object.freeze({ launch: { extra: EXTRA }, background: false });
const UNKNOWN_MODEL = 'm10-no-such-model';
const CUT_FAMILY = 'm19-cut-resume';

const isOwn = (frame) => frame.parent_tool_use_id == null;
const blocksOf = (frame) => (Array.isArray(frame.message?.content) ? frame.message.content : []);
const msOf = (driver, index) => driver.session.frames.find((f) => f.index === index)?.ms ?? null;

/**
 * What the `stream_event` and `assistant` frames from `from` on say, reply by reply: a reply is a
 * `message_start` and what follows it on the same side (the session's own, or a worker's) until its
 * `message_stop`; an `assistant` frame is matched to a reply by its `message.id`, and to a block of
 * it by its order among that reply's frames (M16, C34).
 */
function replies(driver, from) {
  const aliases = new Map();
  const alias = (id) => { if (!aliases.has(id)) aliases.set(id, `r${aliases.size + 1}`); return aliases.get(id); };
  const byId = new Map();
  const current = { own: null, worker: null };
  const stray = { ownEventsBeforeAnyStart: 0, eventsOfUnknownType: {} };
  for (const entry of received(driver, from)) {
    const f = entry.frame;
    if (typeKey(f) !== 'stream_event') continue;
    const side = isOwn(f) ? 'own' : 'worker';
    const event = f.event ?? {};
    if (event.type === 'message_start') {
      const id = event.message?.id ?? `<no id ${entry.index}>`;
      const reply = { id, alias: alias(id), side, model: event.message?.model ?? null, startIndex: entry.index, startMs: entry.ms, uuidOnEvents: typeof f.uuid === 'string', blocks: [], stopIndex: null, stopReason: null, assistantFrames: [] };
      byId.set(id, reply);
      current[side] = reply;
      continue;
    }
    const reply = current[side];
    if (reply === null) { stray.ownEventsBeforeAnyStart += 1; continue; }
    switch (event.type) {
      case 'content_block_start':
        reply.blocks.push({ index: event.index, type: event.content_block?.type ?? null, startIndex: entry.index, startMs: entry.ms, deltas: [], deltaTypes: {}, stopIndex: null });
        break;
      case 'content_block_delta': {
        const block = reply.blocks.find((b) => b.index === event.index) ?? reply.blocks.at(-1);
        if (!block) break;
        block.deltas.push(entry);
        const kind = event.delta?.type ?? '?';
        block.deltaTypes[kind] = (block.deltaTypes[kind] ?? 0) + 1;
        break;
      }
      case 'content_block_stop': {
        const block = reply.blocks.find((b) => b.index === event.index) ?? reply.blocks.at(-1);
        if (block) block.stopIndex = entry.index;
        break;
      }
      case 'message_delta':
        reply.stopReason = event.delta?.stop_reason ?? null;
        break;
      case 'message_stop':
        reply.stopIndex = entry.index;
        break;
      default:
        stray.eventsOfUnknownType[event.type ?? '?'] = (stray.eventsOfUnknownType[event.type ?? '?'] ?? 0) + 1;
    }
  }
  // The `assistant` frames, one block each (M16, C34), matched to the reply their `message.id` names.
  const unmatched = [];
  for (const entry of framesOf(driver, 'assistant', from)) {
    const f = entry.frame;
    const reply = byId.get(f.message?.id);
    const blocks = blocksOf(f);
    const fact = { index: entry.index, ms: entry.ms, side: isOwn(f) ? 'own' : 'worker', model: f.message?.model ?? null, blocks: blocks.map((b) => b.type), textUnits: blocks.filter((b) => b.type === 'text').reduce((sum, b) => sum + String(b.text ?? '').length, 0), uuid: typeof f.uuid === 'string', stop: f.message?.stop_reason ?? null };
    if (!reply) { unmatched.push({ ...fact, messageIdSeen: typeof f.message?.id === 'string' }); continue; }
    const k = reply.assistantFrames.length;
    const block = reply.blocks[k] ?? null;
    const text = block ? block.deltas.map((d) => d.frame.event?.delta?.text ?? '').join('') : null;
    reply.assistantFrames.push({
      ...fact, matchedBlock: block ? block.index : null, blockTypeMatches: block ? blocks[0]?.type === block.type : null,
      afterTheBlocksLastDelta: block && block.deltas.length ? entry.index > block.deltas.at(-1).index : null, beforeTheBlocksStop: block?.stopIndex !== null && block ? entry.index < block.stopIndex : null,
      msAfterTheLastDelta: block && block.deltas.length ? Math.round(entry.ms - block.deltas.at(-1).ms) : null,
      textEqualsTheDeltas: block && block.type === 'text' ? text === String(blocks.find((b) => b.type === 'text')?.text ?? '') : null,
    });
  }
  return {
    replies: [...byId.values()].map((r) => ({
      alias: r.alias, side: r.side, model: r.model, startIndex: r.startIndex, uuidOnEvents: r.uuidOnEvents, stopReason: r.stopReason, stopped: r.stopIndex !== null,
      blocks: r.blocks.map((b) => ({ index: b.index, type: b.type, deltaTypes: b.deltaTypes, text: b.type === 'text' ? deltaFacts(b.deltas, (frame) => frame.event?.delta?.text) : { count: b.deltas.length }, stopped: b.stopIndex !== null })),
      assistantFrames: r.assistantFrames, framesPerBlock: r.blocks.length ? r.assistantFrames.length / r.blocks.length : null,
    })),
    unmatchedAssistantFrames: unmatched,
    ...stray,
    streamEvents: { own: received(driver, from).filter((f) => typeKey(f.frame) === 'stream_event' && isOwn(f.frame)).length, worker: received(driver, from).filter((f) => typeKey(f.frame) === 'stream_event' && !isOwn(f.frame)).length },
  };
}

/** The turn's bounds, as M16 reads them (C31, C41, C75): its `init`, its `result`, the lifecycle frames that name the prompt. */
function turnFacts(driver, from, uuid) {
  const init = initOf(driver, from)?.frame ?? null;
  const result = resultOf(driver, from) ?? null;
  const lifecycle = framesOf(driver, 'command_lifecycle', from);
  const counts = {};
  for (const f of received(driver, from)) { const key = typeKey(f.frame); counts[key] = (counts[key] ?? 0) + 1; }
  return {
    init: init ? { model: init.model ?? null, permissionMode: init.permissionMode ?? null, tools: (init.tools ?? []).filter((tool) => !String(tool).startsWith('mcp__')) } : null,
    result: result ? { subtype: result.frame.subtype ?? null, isError: result.frame.is_error === true, terminal: result.frame.terminal_reason ?? null, numTurns: result.frame.num_turns ?? null } : null,
    lifecycle: lifecycle.map((f) => ({ state: f.frame.state ?? null, namesOurId: f.frame.command_uuid === uuid })),
    typeCounts: counts, requests: driver.requestsSeen.length, droppedDeltas: driver.session.recorder.deltas,
    outline: outline(driver, from, { sent: [uuid] }).filter((row) => row.recv !== 'stream_event'),
  };
}

/** The first `message_start` of the session's own from a model: what C60 would report the reference at. */
function earlyReference(driver, from) {
  const starts = received(driver, from).filter((f) => typeKey(f.frame) === 'stream_event' && isOwn(f.frame) && f.frame.event?.type === 'message_start' && f.frame.event?.message?.model !== '<synthetic>');
  const firstText = received(driver, from).find((f) => typeKey(f.frame) === 'stream_event' && isOwn(f.frame) && f.frame.event?.type === 'content_block_delta' && f.frame.event?.delta?.type === 'text_delta');
  const firstAssistant = framesOf(driver, 'assistant', from).find((f) => isOwn(f.frame) && f.frame.message?.model !== '<synthetic>');
  const init = initOf(driver, from);
  const first = starts[0] ?? null;
  return {
    arrived: first !== null, msAfterInit: first && init ? Math.round(first.ms - init.ms) : null,
    beforeTheFirstTextDelta: first && firstText ? first.index < firstText.index : null,
    msBeforeTheFirstModelAssistantFrame: first && firstAssistant ? Math.round(firstAssistant.ms - first.ms) : null,
    sessionIdOnIt: typeof first?.frame.session_id === 'string', sameAsInit: first && init ? first.frame.session_id === init.frame.session_id : null,
  };
}

/** A resume's launch: whether it opened, and what it wrote and how it exited when it did not (K24, K25). */
function resumeOf(attempt) {
  const stayedUp = attempt.opened && !attempt.driver.tree?.rootExited;
  return { opened: attempt.opened, initializeAnswered: attempt.initializeAnswered, stayedUp, exitCode: attempt.exit?.code ?? null, exitMs: attempt.exitMs, stdoutFrames: attempt.stdoutFrames, garbageLines: attempt.garbageLines, stderrBytes: attempt.stderrBytes };
}

const oneTurn = (id, name, title, successCondition, prompt, { launch = {}, check } = {}) => ({
  id, name, turns: 1, title, successCondition,
  async run(ctx) {
    if (!ctx.model) return notRun('no model chosen: run M16\'s --scenario discover first');
    const driver = await ctx.open({ ...SETTLED, launch: { ...SETTLED.launch, ...launch } });
    const uuid = randomUUID();
    const from = await ctx.prompt(driver, typeof prompt === 'function' ? prompt(ctx) : prompt, { uuid });
    const end = await ctx.turnEnd(driver, from);
    await sleep(1_500);
    const notes = { endStatus: end.status, isError: end.isError ?? null, reference: earlyReference(driver, from), ...replies(driver, from), ...turnFacts(driver, from, uuid) };
    const why = check?.(driver, from, notes, end) ?? null;
    return why ? didNotHappen(why, notes) : happened(notes, end.index);
  },
});

const noStreamedOwnText = (notes) => (notes.replies.some((r) => r.side === 'own' && r.blocks.some((b) => b.type === 'text' && b.text.count > 0)) ? null : 'no text of the session\'s own came as deltas');

const SCENARIOS = {
  'chat-t1': oneTurn('m19-t1', 'm19-t1-basic', "K2: T1, a basic turn, with partial messages", 'A read of sample.txt, a streamed answer, then the end of the turn',
    'Read the file sample.txt in the current folder, then tell me in one sentence what the cat is called.',
    { check: (driver, from, notes) => (driver.events(from).some((e) => e.kind === 'tool-call') ? noStreamedOwnText(notes) : 'the turn ended without a tool call') }),

  'chat-t3': oneTurn('m19-t3', 'm19-t3-subagent', 'K2: T3, a sub-agent, with partial messages', "A worker's start and end, and which of its frames came as stream events",
    'Use the Agent tool to hand this small task to a sub-agent: read notes-3.txt and report its contents. Do not read the file yourself. When the sub-agent is done, tell me in one sentence what it found.',
    { check: (driver, from, notes, end) => {
      const events = driver.events(from).filter((e) => e.index <= end.index);
      const start = events.find((e) => e.kind === 'worker-start');
      const stop = events.find((e) => e.kind === 'worker-end' && (!start || e.index > start.index));
      notes.workerEvents = events.filter((e) => e.kind.startsWith('worker')).map((e) => ({ kind: e.kind, source: e.source ?? null, status: e.status ?? null }));
      notes.ownRepliesWithoutAnAssistantFrame = notes.replies.filter((r) => r.side === 'own' && r.assistantFrames.length === 0).map((r) => r.alias);
      return !start || !stop ? (start ? 'a worker started but no end was seen before the turn ended' : 'no worker started') : null;
    } }),

  'chat-t4': {
    id: 'm19-t4', name: 'm19-t4-interrupt', turns: 1,
    title: "K2: T4's prompt, an interrupt while a text of the session's own is written",
    successCondition: 'Deltas of a text, an interrupt, then the frame that completes what was written and the turn\'s end',
    async run(ctx) {
      if (!ctx.model) return notRun('no model chosen: run M16\'s --scenario discover first');
      const driver = await ctx.open(SETTLED);
      const uuid = randomUUID();
      const from = await ctx.prompt(driver, 'Read notes-1.txt, notes-2.txt, notes-3.txt and notes-4.txt one at a time, in that order, and then summarise all four in one sentence.', { uuid });
      // The first text delta of the session's own, wherever in the turn it comes, or the turn's end before any.
      const hit = await ctx.frame(driver, (f) => (typeKey(f) === 'stream_event' && isOwn(f) && f.event?.type === 'content_block_delta' && f.event?.delta?.type === 'text_delta') || typeKey(f) === 'result', from);
      if (typeKey(hit.frame) === 'result') return didNotHappen('the turn ended before any text delta of the session\'s own', { ...replies(driver, from), ...turnFacts(driver, from, uuid) });
      const toolCallsBefore = driver.events(from).filter((e) => e.kind === 'tool-call' && e.index < hit.index).length;
      const reply = await driver.interrupt();
      const end = await ctx.turnEnd(driver, from);
      await sleep(2_000);
      const facts = replies(driver, from);
      const after = received(driver, hit.index + 1).map((f) => (typeKey(f.frame) === 'stream_event' ? `stream_event/${f.frame.event?.type}${f.frame.event?.delta?.type ? `:${f.frame.event.delta.type}` : ''}` : typeKey(f.frame)));
      const notes = { interruptAccepted: reply.ok, interruptMsAfterTheFirstDelta: Math.round(msOf(driver, reply.index) - hit.ms), toolCallsBeforeTheText: toolCallsBefore, endStatus: end.status, terminalReason: end.terminalReason ?? null, isError: end.isError ?? null, afterTheFirstDelta: after, ...facts, ...turnFacts(driver, from, uuid) };
      return happened(notes, end.index);
    },
  },

  'chat-t5': {
    id: 'm19-t5', name: 'm19-t5-error', turns: 1,
    title: "K2: T5, an unknown model id, with partial messages",
    successCondition: 'The error frame',
    async run(ctx) {
      const attempt = await ctx.tryOpen({ ...SETTLED, launch: { ...SETTLED.launch, model: UNKNOWN_MODEL, effort: null } });
      const driver = attempt.driver;
      if (!attempt.opened) return happened({ failedAt: 'launch', promptSent: false, exitCode: attempt.exit?.code ?? null, stdoutFrames: attempt.stdoutFrames });
      const uuid = randomUUID();
      const from = await ctx.prompt(driver, 'Say hello in one word.', { uuid });
      const hit = await ctx.wait(driver, (e) => e.kind === 'error' || e.kind === 'turn-end', from);
      const end = hit.kind === 'turn-end' ? hit : await ctx.turnEnd(driver, from);
      await sleep(1_000);
      const failed = hit.kind === 'error' || hit.isError;
      const notes = { failedAt: 'turn', promptSent: true, via: hit.kind, endStatus: end.status, ...replies(driver, from), ...turnFacts(driver, from, uuid) };
      if (!failed) return didNotHappen('the turn ended normally on an unknown model', notes);
      return happened(notes, end.index);
    },
  },

  'chat-command': oneTurn('m19-command', 'm19-command-refused', "K2: a prompt that names one of the CLI's commands, with partial messages", "The CLI's own answer, with no model called: whether a reply the CLI writes itself sends stream events",
    (ctx) => `/model ${ctx.state.modelB}`,
    { check: (driver, from, notes) => {
      const assistants = framesOf(driver, 'assistant', from);
      notes.answeredByTheCliItself = assistants.some((f) => f.frame.message?.model === '<synthetic>' && 'local_command_source' in f.frame);
      notes.answeredByTheModel = assistants.some((f) => f.frame.message?.model !== '<synthetic>');
      return !notes.answeredByTheCliItself || notes.answeredByTheModel ? 'the prompt was not answered by the CLI itself' : null;
    } }),

  'chat-markdown': oneTurn('m19-markdown', 'm19-markdown', 'K2: a long Markdown answer with a code block and a table, at a higher effort', "An answer of some length as text deltas, a thinking block before it if the model thinks, and the turn's end: the deltas' sizes and rate",
    'Without using any tool, write about 400 words in Markdown explaining how a tide table is read: use two headings, a bulleted list, a fenced JavaScript code block of about 25 lines that computes the next high tide from a list of times, and a table with at least 10 rows of example times and heights.',
    { launch: { effort: 'high' }, check: (driver, from, notes) => {
      notes.thinkingBlocks = notes.replies.flatMap((r) => r.blocks.filter((b) => b.type === 'thinking')).length;
      notes.deltaFrameBytes = sizes(driver.frameBytes.filter((f) => f.type === 'stream_event').map((f) => f.bytes));
      return noStreamedOwnText(notes);
    } }),

  'chat-cut-resume': {
    id: 'm19-cut-resume', name: 'm19-cut', family: CUT_FAMILY, turns: 2, atMost: true,
    title: "K2: a new conversation whose process is ended by force during its first text block, before any model `assistant` frame, then `--resume` of its id with a prompt",
    successCondition: 'The early reference, no model `assistant` frame before the process was gone, then whether the resume opens and what it holds of the prompt and the partial answer',
    async run(ctx) {
      if (!ctx.model) return notRun('no model chosen: run M16\'s --scenario discover first');
      if (process.platform !== 'win32') return notRun('Windows only: elsewhere the process layer ends the input first, then signals the group');
      const notes = {};
      const first = await ctx.open({ ...SETTLED, label: 'cut' });
      const firstId = randomUUID();
      const from = await ctx.prompt(first, 'Remember the word HARBOUR. Then, without using any tool, write 40 numbered sentences about lighthouses, one per line.', { uuid: firstId });
      const start = await ctx.frame(first, (f) => (typeKey(f) === 'stream_event' && isOwn(f) && f.event?.type === 'message_start' && f.event?.message?.model !== '<synthetic>') || typeKey(f) === 'result', from);
      if (typeKey(start.frame) === 'result') return didNotHappen('the turn ended before any model message started', { ...replies(first, from), ...turnFacts(first, from, firstId) });
      const sessionId = initOf(first, from)?.frame.session_id ?? null;
      // Three text deltas of the answer, so that something of it was written, then the end the app's process layer makes.
      let count = 0;
      const third = await ctx.frame(first, (f) => (typeKey(f) === 'stream_event' && isOwn(f) && f.event?.type === 'content_block_delta' && f.event?.delta?.type === 'text_delta' && ++count >= 3) || typeKey(f) === 'assistant' || typeKey(f) === 'result', start.index + 1);
      if (typeKey(third.frame) !== 'stream_event') return didNotHappen(`a ${typeKey(third.frame)} frame came before three text deltas`, { ...replies(first, from), ...turnFacts(first, from, firstId) });
      const forced = await ctx.endByForce(first);
      const modelAssistantBefore = framesOf(first, 'assistant', from).filter((f) => isOwn(f.frame) && f.frame.message?.model !== '<synthetic>');
      const { outline: outlineCut, ...cut } = turnFacts(first, from, firstId);
      notes.cut = { reference: earlyReference(first, from), textDeltasBeforeTheEnd: count, forcedEnd: { ...forced, msAfterTheMessageStart: Math.round(forced.atMs - start.ms) }, modelAssistantFramesBeforeTheEnd: modelAssistantBefore.length, framesAfterTheEndWasStarted: first.session.frames.filter((f) => f.dir === 'recv' && f.ms >= forced.atMs).map((f) => typeKey(f.frame)), ...replies(first, from), ...cut };
      notes.outlineCut = outlineCut;
      if (!sessionId) return didNotHappen('no `init` named a session to resume', notes);
      if (modelAssistantBefore.length > 0) return didNotHappen('a model `assistant` frame came before the process was ended: the case was not made', notes);
      if (!forced.taskkillOk || !forced.exited) return didNotHappen('the process was not ended by the forced end', notes);

      const attempt = await ctx.tryOpen({ ...SETTLED, label: 'resumed', launch: { ...SETTLED.launch, resume: sessionId } });
      if (attempt.opened) await sleep(1_500);
      notes.resume = resumeOf(attempt);
      notes.resumedAfterACutFirstAnswer = notes.resume.stayedUp;
      // Not resumed is the finding too, and no second prompt goes out.
      if (!notes.resumedAfterACutFirstAnswer) return happened(notes);
      const resumed = attempt.driver;
      const secondId = randomUUID();
      const from2 = await ctx.prompt(resumed, 'Without using any tool, answer in one sentence: which word did I ask you to remember, and how many numbered sentences about lighthouses had you written before this message, if any?', { uuid: secondId });
      const end = await ctx.turnEnd(resumed, from2);
      await sleep(1_000);
      const text = ownText(resumed, from2);
      const { outline: outlineResumed, ...turn } = turnFacts(resumed, from2, secondId);
      notes.turn = { endStatus: end.status, isError: end.isError, initNamesTheResumedId: initOf(resumed, from2)?.frame.session_id === sessionId, knowsTheWord: /harbour/i.test(text), saysNoneWereWritten: /\b(none|no sentences|not written|had not|hadn't|zero|first message)\b/i.test(text), namesANumber: /\b\d+\b/.test(text), toolCalls: resumed.events(from2).filter((e) => e.kind === 'tool-call').length, ...replies(resumed, from2), ...turn };
      notes.outlineResumed = outlineResumed;
      return happened(notes);
    },
  },
};

if (isMain(import.meta.url)) {
  await runSpike('m19-k2', (frame) => {
    if (frame.args.list) {
      for (const [key, scenario] of Object.entries(SCENARIOS)) log(`${key.padEnd(18)} ${String(scenario.turns).padStart(2)} turn(s)${scenario.atMost ? ' at most' : ''}  ${scenario.title}`);
      log(`total: ${Object.values(SCENARIOS).reduce((sum, scenario) => sum + scenario.turns, 0)} turn(s) at most for one run of each`);
      return 0;
    }
    const scenario = SCENARIOS[String(frame.args.scenario ?? '')];
    if (!scenario) { warn(`usage: node spikes/m19/k2.mjs --scenario ${Object.keys(SCENARIOS).join('|')} [--confirm-turns <n>] [--again] [--path <executable>]`); return 1; }
    log(`K2: M16's launch with ${EXTRA.join(' ')}`);
    return runScenario('m19-k2', scenario, frame, OPTIONS);
  });
}
