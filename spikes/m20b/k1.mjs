// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// M20b spike K1 (docs/planning/_archive/M20b-spec-sheet.md; C13–C18): Claude's `side_question` control
// request, read in the spike-only SDK's runtime and never traced, under M16's launch as M20a
// leaves it less `--disable-slash-commands` (C54), with `--include-partial-messages` as M19 added it,
// in M16's scratch configuration folder, with M19b's three files beside M10's.
//
//   node spikes/m20b/k1.mjs --list
//   node spikes/m20b/k1.mjs --scenario seed|idle|during|two|followup|cancel|flagged --confirm-turns <n> [--again]
//
// Without --confirm-turns equal to the scenario's count it prints its plan and launches nothing
// (S6). One invocation is one run; at most three runs per scenario (M10's ledger, under
// spikes/output/m20b). `seed` starts the session and saves its id; every other scenario resumes it
// by `--resume`, as the app resumes a session whose process is closed (C10). A side question is
// counted as a prompt: it is one the model answers.
//
// What a run records is never a text: whether the request is taken and its reply's shape (keys,
// a null or synthetic answer, a fallback model, usage keys), the progress frames by status and
// time, what the answer knows of the turn in flight and of the aside's history (a yes or no), the
// turn's `command_lifecycle` bounds, whether a hook of the user's fires for it, whether the saved
// session's history file grows (by size alone), and what the cancel does.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { typeKey } from '../m10/claude/frames.mjs';
import { sleep } from '../m10/lib/deadlines.mjs';
import { isMain } from '../m10/lib/paths.mjs';
import { log, runSpike, warn } from '../m10/lib/spike.mjs';
import { CONFIG_DIR, didNotHappen, framesOf, happened, initOf, notRun, outline, resultOf, runScenario } from '../m16/lib/common.mjs';
import { M19ClaudeDriver, OMITTED_CLAUDE, received } from '../m19/lib/common.mjs';
import { FILES } from '../../tests/fixtures/project-files.mjs';
import { LONG_PROMPT, M20B_DIR, QUESTIONS, SEED_PROMPT, historyBytes, readState, typeCounts, writeState } from './lib/common.mjs';

const OPTIONS = { dir: M20B_DIR, milestone: 'M20b', Driver: M19ClaudeDriver, omitted: OMITTED_CLAUDE };
/** M16's settled launch less the flag (C54), with M19's partial messages (C9): the app's launch from M20b. */
const EXTRA = ['--include-partial-messages'];
const SETTLED = Object.freeze({ launch: { extra: EXTRA }, background: false });
/** The one launch under the flag, for the record of what it gates (K1's last prompt). */
const FLAGGED = Object.freeze({ launch: { extra: [...EXTRA, '--disable-slash-commands'] }, background: false });

const isOwn = (frame) => frame.parent_tool_use_id == null;
const msOf = (driver, index) => driver.session.frames.find((f) => f.index === index)?.ms ?? null;
const blocksOf = (frame) => (Array.isArray(frame.message?.content) ? frame.message.content : []);

/** The hook K1 sets for `idle`: it notes which event ran it and when, and takes no time. */
const HOOK_SCRIPT = `// Written by fat-g's M20b spike (K1), and removed after its run: a hook that notes its event and the time.
import { appendFileSync } from 'node:fs';
const [, , label] = process.argv;
appendFileSync(new URL('./fatg-spike-m20b-hook.log', import.meta.url), label + ' ' + Date.now() + '\\n');
`;

/** Sends a side question as the SDK's runtime does and resolves with its reply; the turn is counted first. */
async function askSide(driver, ctx, question, { history } = {}) {
  ctx.countTurn();
  const requestId = `m10-${++driver.counter}`;
  const from = driver.nextIndex;
  const sentAt = driver.tree.elapsed();
  await driver.session.send({ type: 'control_request', request_id: requestId, request: { subtype: 'side_question', question, ...(history?.length ? { history: [...history] } : {}) } });
  const reply = driver.session.waitFor((f) => f.type === 'control_response' && f.response?.request_id === requestId, { wait: 'scenario', ms: ctx.left(), fromIndex: from });
  return { requestId, from, sentAt, reply };
}

const cacheKeys = (value, depth = 0) => {
  if (!value || typeof value !== 'object' || depth > 4) return {};
  let out = {};
  for (const [key, inner] of Object.entries(value)) {
    if (/cache/i.test(key) && typeof inner === 'number') out[key] = inner;
    else if (inner && typeof inner === 'object') out = { ...out, ...cacheKeys(inner, depth + 1) };
  }
  return out;
};

/** What one side question's reply and its frames say: shapes, times and counts, never the answer. */
function sideFacts(driver, ask, replied) {
  const frame = replied.frame;
  const response = frame.response ?? {};
  const value = response.subtype === 'success' ? response.response ?? null : null;
  const answer = typeof value?.response === 'string' ? value.response : null;
  const progress = received(driver, ask.from).filter((f) => typeKey(f.frame) === 'system/control_request_progress' && f.frame.request_id === ask.requestId).map((f) => ({ status: f.frame.status ?? null, msAfterSend: Math.round(f.ms - ask.sentAt), attempt: f.frame.attempt ?? null, keys: Object.keys(f.frame).sort() }));
  const between = {};
  for (const f of received(driver, ask.from)) {
    if (f.index >= replied.index) break;
    const key = typeKey(f.frame);
    between[key] = (between[key] ?? 0) + 1;
  }
  return {
    taken: response.subtype === 'success', replySubtype: response.subtype ?? null, errorText: response.subtype === 'error' ? String(response.error ?? '').slice(0, 160) : null,
    msToReply: Math.round(msOf(driver, replied.index) - ask.sentAt),
    replyKeys: value && typeof value === 'object' ? Object.keys(value).sort() : null,
    answerNull: value !== null && value.response === null, answerUnits: answer?.length ?? null, synthetic: value?.synthetic ?? null,
    refusalFallback: value?.refusal_fallback ? { keys: Object.keys(value.refusal_fallback).sort(), originalNamed: typeof value.refusal_fallback.original_model === 'string', fallbackNamed: typeof value.refusal_fallback.fallback_model === 'string' } : null,
    usage: value?.usage && typeof value.usage === 'object' ? { keys: Object.keys(value.usage).sort(), cache: cacheKeys(value.usage) } : null,
    otherCacheKeys: cacheKeys(value),
    progress, framesBetweenSendAndReply: between,
    assistantFramesForIt: received(driver, ask.from).filter((f) => f.index < replied.index && typeKey(f.frame) === 'assistant').length,
    streamEventsForIt: received(driver, ask.from).filter((f) => f.index < replied.index && typeKey(f.frame) === 'stream_event').length,
    _answer: answer,
  };
}

/** The facts without the answer, which stays in memory. */
const noted = ({ _answer, ...facts }) => facts;

/** The turn's bounds, as M16 reads them (C31): its lifecycle frames, its `init`, its `result`. */
function turnFacts(driver, from, uuid) {
  const init = initOf(driver, from)?.frame ?? null;
  const result = resultOf(driver, from) ?? null;
  const lifecycle = framesOf(driver, 'command_lifecycle', from);
  return {
    init: init ? { model: init.model ?? null, permissionMode: init.permissionMode ?? null, tools: (init.tools ?? []).filter((tool) => !String(tool).startsWith('mcp__')), slashCommands: Array.isArray(init.slash_commands) ? init.slash_commands.length : null } : null,
    result: result ? { index: result.index, subtype: result.frame.subtype ?? null, isError: result.frame.is_error === true, numTurns: result.frame.num_turns ?? null } : null,
    lifecycle: lifecycle.map((f) => ({ index: f.index, state: f.frame.state ?? null, namesOurId: f.frame.command_uuid === uuid })),
  };
}

/** Resumes the seed session, or starts a new one for `seed` and the flagged launch. */
async function openSession(ctx, settled, resume) {
  const launch = resume ? { ...settled.launch, resume } : settled.launch;
  return ctx.open({ ...settled, launch });
}

const SCENARIOS = {
  seed: {
    id: 'm20b-seed', name: 'm20b-seed', turns: 1, files: FILES,
    title: 'K1: a turn that gives the session something to hold, reading the three files',
    successCondition: "Reads of the three files and the turn's end; the session's id saved for the other scenarios",
    async run(ctx) {
      if (!ctx.model) return notRun('no model chosen: run M16\'s --scenario discover first');
      const driver = await openSession(ctx, SETTLED, null);
      const uuid = randomUUID();
      const from = await ctx.prompt(driver, SEED_PROMPT, { uuid });
      const end = await ctx.turnEnd(driver, from);
      await sleep(1_500);
      const sessionId = initOf(driver, from)?.frame.session_id ?? null;
      const reads = driver.events(from).filter((e) => e.kind === 'tool-call').map((e) => e.name);
      const notes = { endStatus: end.status, isError: end.isError ?? null, toolCalls: reads, ...turnFacts(driver, from, uuid), historyFileBytes: sessionId ? historyBytes(CONFIG_DIR, ctx.project, sessionId) : null, outline: outline(driver, from, { sent: [uuid] }).filter((row) => row.recv !== 'stream_event') };
      if (!sessionId) return didNotHappen('no init named the session', notes);
      writeState({ claudeSessionId: sessionId, claudeSeededAt: new Date().toISOString() });
      if (reads.length === 0) return didNotHappen('the turn read nothing', notes);
      return happened(notes, end.index);
    },
  },

  idle: {
    id: 'm20b-idle', name: 'm20b-idle', turns: 1, files: FILES,
    title: 'K1: a side question while the session is idle, under SessionStart, UserPromptSubmit and Stop hooks',
    successCondition: "The request taken and its reply's shape; which hooks ran for it; whether the session's history file grew",
    async run(ctx) {
      const state = readState();
      if (!state.claudeSessionId) return notRun('no seed session: run --scenario seed first');
      const script = ctx.writeConfig('fatg-spike-m20b-hook.mjs', HOOK_SCRIPT);
      const hookLog = ctx.expectWritten('fatg-spike-m20b-hook.log');
      const command = (label) => ({ hooks: [{ type: 'command', command: `node ${script.split('\\').join('/')} ${label}`, timeout: 30 }] });
      ctx.writeConfig('settings.json', `${JSON.stringify({ hooks: { SessionStart: [command('SessionStart')], UserPromptSubmit: [command('UserPromptSubmit')], Stop: [command('Stop')] } }, null, 2)}\n`);
      const driver = await openSession(ctx, SETTLED, state.claudeSessionId);
      await sleep(1_500);
      const bytesBefore = historyBytes(CONFIG_DIR, ctx.project, state.claudeSessionId);
      const spawnedAt = driver.tree.spawnedAt;
      const linesBefore = existsSync(hookLog) ? readFileSync(hookLog, 'utf8').trim().split('\n').filter(Boolean).length : 0;
      const ask = await askSide(driver, ctx, QUESTIONS.idle.text);
      const replied = await ask.reply;
      await sleep(2_500);
      const bytesAfter = historyBytes(CONFIG_DIR, ctx.project, state.claudeSessionId);
      const lines = existsSync(hookLog) ? readFileSync(hookLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => line.split(' ')) : [];
      const hooks = Object.fromEntries(['SessionStart', 'UserPromptSubmit', 'Stop'].map((label) => [label, lines.filter(([who]) => who === label).map(([, stamp]) => ({ msAfterSpawn: Number(stamp) - spawnedAt, afterTheQuestionWasSent: Number(stamp) - spawnedAt >= ask.sentAt }))]));
      const facts = sideFacts(driver, ask, replied);
      const notes = {
        ...noted(facts), answerLooksRight: facts._answer ? QUESTIONS.idle.looksFor.test(facts._answer) : null,
        hooks: { linesBeforeTheQuestion: linesBefore, ...hooks }, hookFrames: received(driver, ask.from).filter((f) => typeKey(f.frame).startsWith('system/hook_')).map((f) => typeKey(f.frame)),
        historyFile: { found: bytesBefore !== null, bytesBefore, bytesAfter, grewBy: bytesBefore !== null && bytesAfter !== null ? bytesAfter - bytesBefore : null },
        resultFrames: framesOf(driver, 'result', ask.from).length, initAfterTheQuestion: framesOf(driver, 'system/init', ask.from).length,
        typeCounts: typeCounts(driver, typeKey, ask.from), outline: outline(driver, ask.from).filter((row) => row.recv !== 'stream_event'),
      };
      if (!facts.taken) return didNotHappen(`the request was not taken: ${facts.errorText ?? facts.replySubtype}`, notes);
      return happened(notes, replied.index);
    },
  },

  during: {
    id: 'm20b-during', name: 'm20b-during', turns: 2, files: FILES,
    title: "K1: a side question while a turn of the session's runs",
    successCondition: "The reply matched by its id, what it knows of the turn in flight, and the turn's bounds untouched",
    async run(ctx) {
      const state = readState();
      if (!state.claudeSessionId) return notRun('no seed session: run --scenario seed first');
      const driver = await openSession(ctx, SETTLED, state.claudeSessionId);
      const uuid = randomUUID();
      const from = await ctx.prompt(driver, LONG_PROMPT, { uuid });
      // Once the turn runs: its `init`, or its first tool call, whichever comes first.
      const hit = await ctx.frame(driver, (f) => typeKey(f) === 'system/init' || typeKey(f) === 'assistant' || typeKey(f) === 'result', from);
      if (typeKey(hit.frame) === 'result') return didNotHappen('the turn ended before it had begun', turnFacts(driver, from, uuid));
      const ask = await askSide(driver, ctx, QUESTIONS.during.text);
      const replied = await ask.reply;
      const end = await ctx.turnEnd(driver, from);
      await sleep(1_500);
      const facts = sideFacts(driver, ask, replied);
      const turn = turnFacts(driver, from, uuid);
      const notes = {
        ...noted(facts), seesTheWordOfTheTurnInFlight: facts._answer ? QUESTIONS.during.looksFor.test(facts._answer) : null, seesTheSeedFiles: facts._answer ? QUESTIONS.during.alsoLooksFor.test(facts._answer) : null,
        askedMsAfterThePrompt: Math.round(ask.sentAt - msOf(driver, from)), repliedBeforeTheTurnEnded: replied.index < end.index, endStatus: end.status, isError: end.isError ?? null,
        turnToolCalls: driver.events(from).filter((e) => e.kind === 'tool-call' && e.index <= end.index).length, ...turn,
        resultFrames: framesOf(driver, 'result', from).length, typeCounts: typeCounts(driver, typeKey, from), outline: outline(driver, from, { sent: [uuid] }).filter((row) => row.recv !== 'stream_event'),
      };
      if (!facts.taken) return didNotHappen(`the request was not taken during the turn: ${facts.errorText ?? facts.replySubtype}`, notes);
      return happened(notes, end.index);
    },
  },

  two: {
    id: 'm20b-two', name: 'm20b-two', turns: 2, files: FILES,
    title: 'K1: two side questions at once, the session idle',
    successCondition: 'Both replies, each matched by its own id, and their progress frames apart',
    async run(ctx) {
      const state = readState();
      if (!state.claudeSessionId) return notRun('no seed session: run --scenario seed first');
      const driver = await openSession(ctx, SETTLED, state.claudeSessionId);
      await sleep(1_000);
      const a = await askSide(driver, ctx, QUESTIONS.twoA.text);
      const b = await askSide(driver, ctx, QUESTIONS.twoB.text);
      const [ra, rb] = await Promise.all([a.reply, b.reply]);
      await sleep(1_500);
      const fa = sideFacts(driver, a, ra);
      const fb = sideFacts(driver, b, rb);
      const notes = {
        first: { ...noted(fa), answerLooksRight: fa._answer ? QUESTIONS.twoA.looksFor.test(fa._answer) : null, mentionsTheOtherQuestion: fa._answer ? QUESTIONS.twoB.looksFor.test(fa._answer) : null },
        second: { ...noted(fb), answerLooksRight: fb._answer ? QUESTIONS.twoB.looksFor.test(fb._answer) : null, mentionsTheOtherQuestion: fb._answer ? QUESTIONS.twoA.looksFor.test(fb._answer) : null },
        sentMsApart: Math.round(b.sentAt - a.sentAt), repliedInOrder: ra.index < rb.index, idsDistinct: a.requestId !== b.requestId,
        progressNamingNeither: received(driver, a.from).filter((f) => typeKey(f.frame) === 'system/control_request_progress' && ![a.requestId, b.requestId].includes(f.frame.request_id)).length,
        typeCounts: typeCounts(driver, typeKey, a.from), outline: outline(driver, a.from).filter((row) => row.recv !== 'stream_event'),
      };
      if (!fa.taken || !fb.taken) return didNotHappen('one of the two was not taken', notes);
      return happened(notes, Math.max(ra.index, rb.index));
    },
  },

  followup: {
    id: 'm20b-followup', name: 'm20b-followup', turns: 1, files: FILES,
    title: "K1: a follow-up carrying the aside's earlier exchange as `history`",
    successCondition: 'The reply, and whether the answer knows the word the history planted',
    async run(ctx) {
      const state = readState();
      if (!state.claudeSessionId) return notRun('no seed session: run --scenario seed first');
      const driver = await openSession(ctx, SETTLED, state.claudeSessionId);
      await sleep(1_000);
      const history = [{ question: QUESTIONS.followupHistory.question, response: QUESTIONS.followupHistory.response }];
      const ask = await askSide(driver, ctx, QUESTIONS.followup.text, { history });
      const replied = await ask.reply;
      await sleep(1_500);
      const facts = sideFacts(driver, ask, replied);
      const notes = { ...noted(facts), historyPairs: history.length, knowsTheHistoryWord: facts._answer ? QUESTIONS.followup.looksFor.test(facts._answer) : null, typeCounts: typeCounts(driver, typeKey, ask.from), outline: outline(driver, ask.from).filter((row) => row.recv !== 'stream_event') };
      if (!facts.taken) return didNotHappen(`the request was not taken: ${facts.errorText ?? facts.replySubtype}`, notes);
      return happened(notes, replied.index);
    },
  },

  cancel: {
    id: 'm20b-cancel', name: 'm20b-cancel', turns: 1, files: FILES,
    title: 'K1: a Stop by `control_cancel_request` on a side question that asks for a long answer',
    successCondition: 'What comes after the cancel: a reply and when, or none, and whether the model call ended',
    async run(ctx) {
      const state = readState();
      if (!state.claudeSessionId) return notRun('no seed session: run --scenario seed first');
      const driver = await openSession(ctx, SETTLED, state.claudeSessionId);
      await sleep(1_000);
      const ask = await askSide(driver, ctx, QUESTIONS.cancel.text);
      ask.reply.catch(() => {});
      // Once the CLI says it started on it, or after two seconds otherwise.
      const started = await ctx.maybeFrame(driver, (f) => typeKey(f) === 'system/control_request_progress' && f.request_id === ask.requestId && f.status === 'started', ask.from, 5_000);
      if (started === null) await sleep(2_000);
      const cancelAt = driver.tree.elapsed();
      await driver.session.send({ type: 'control_cancel_request', request_id: ask.requestId });
      const replied = await ctx.maybeFrame(driver, (f) => f.type === 'control_response' && f.response?.request_id === ask.requestId, ask.from, 90_000);
      await sleep(2_500);
      const facts = replied ? sideFacts(driver, ask, replied) : null;
      const after = received(driver, ask.from).filter((f) => f.ms >= cancelAt).map((f) => typeKey(f.frame));
      const notes = {
        progressStartedSeen: started !== null, cancelSentMsAfterTheQuestion: Math.round(cancelAt - ask.sentAt),
        replyCame: replied !== null, replyMsAfterTheCancel: replied ? Math.round(msOf(driver, replied.index) - cancelAt) : null,
        ...(facts ? { reply: { ...noted(facts), answerLooksLong: facts._answer ? facts._answer.length > 1_500 : null } } : {}),
        framesAfterTheCancel: after, typeCounts: typeCounts(driver, typeKey, ask.from), outline: outline(driver, ask.from).filter((row) => row.recv !== 'stream_event'),
      };
      return happened(notes, replied?.index ?? null);
    },
  },

  flagged: {
    id: 'm20b-flagged', name: 'm20b-flagged', turns: 1, atMost: true, files: FILES,
    title: 'K1: a side question under `--disable-slash-commands`, in a launch of its own, for the record of what the flag gates',
    successCondition: 'Whether the request is taken under the flag, or how it is refused',
    async run(ctx) {
      if (!ctx.model) return notRun('no model chosen: run M16\'s --scenario discover first');
      const state = readState();
      const driver = await openSession(ctx, FLAGGED, state.claudeSessionId ?? null);
      await sleep(1_000);
      const ask = await askSide(driver, ctx, QUESTIONS.twoA.text);
      const replied = await ask.reply;
      await sleep(1_000);
      const facts = sideFacts(driver, ask, replied);
      const notes = { ...noted(facts), answerLooksRight: facts._answer ? QUESTIONS.twoA.looksFor.test(facts._answer) : null, resumed: Boolean(state.claudeSessionId), typeCounts: typeCounts(driver, typeKey, ask.from), outline: outline(driver, ask.from).filter((row) => row.recv !== 'stream_event') };
      return happened(notes, replied.index);
    },
  },
};

if (isMain(import.meta.url)) {
  await runSpike('m20b-k1', (frame) => {
    if (frame.args.list) {
      for (const [key, scenario] of Object.entries(SCENARIOS)) log(`${key.padEnd(10)} ${String(scenario.turns).padStart(2)} prompt(s)${scenario.atMost ? ' at most' : ''}  ${scenario.title}`);
      log(`total: ${Object.values(SCENARIOS).reduce((sum, scenario) => sum + scenario.turns, 0)} prompt(s) at most for one run of each; a side question counts as one`);
      return 0;
    }
    const scenario = SCENARIOS[String(frame.args.scenario ?? '')];
    if (!scenario) { warn(`usage: node spikes/m20b/k1.mjs --list | --scenario ${Object.keys(SCENARIOS).join('|')} --confirm-turns <n> [--again] [--path <executable>]`); return 1; }
    log(`K1: M16's launch less --disable-slash-commands, with ${EXTRA.join(' ')}; background tasks off; the scratch configuration folder`);
    return runScenario('m20b-k1', scenario, frame, OPTIONS);
  });
}
