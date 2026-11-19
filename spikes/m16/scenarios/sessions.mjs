// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// M16 spikes K2 to K7 (and the first half of K14): a saved Claude session, its resume from a second
// process, the launches that fail, an effort changed in a saved session, two processes at once in
// one folder, a session named with `--session-id`, and what a resume sends of its earlier
// conversation. M10 ran every Claude session with `--no-session-persistence` and traced none of it.
import { randomUUID } from 'node:crypto';
import { sleep } from '../../m10/lib/deadlines.mjs';
import { claudeWindows } from '../../m10/usage.mjs';
import { didNotHappen, framesOf, happened, initOf, notRun, outline, ownText, resultOf, textWaits, writeState } from '../lib/common.mjs';

/** One family: these captures are redacted together, so the saved session's id has one alias across them. */
export const FAMILY = 'm16-saved-session';

export const SAVED_PROMPT = 'Read the file sample.txt in the current folder, then tell me in one sentence where the cat sleeps.';
export const RESUME_PROMPT = 'Without reading any file again, tell me in one sentence what the cat is called.';

const msOf = (driver, index) => driver.session.frames.find((f) => f.index === index)?.ms ?? null;
const initSummary = (driver, from) => {
  const init = initOf(driver, from)?.frame ?? null;
  return init ? { model: init.model ?? null, permissionMode: init.permissionMode ?? null, tools: init.tools ?? null, keys: Object.keys(init).sort() } : null;
};
const resultSummary = (driver, from) => {
  const result = resultOf(driver, from)?.frame ?? null;
  return result ? { subtype: result.subtype ?? null, isError: result.is_error === true, terminal: result.terminal_reason ?? null, numTurns: result.num_turns ?? null, resultIndex: result.result_index ?? null, queuedTurnCount: result.queued_turn_count ?? null } : null;
};
/** Spawn to the `initialize` reply, the prompt to its `init`, and to the turn's end. */
const timings = (driver, from) => ({
  spawnToInitializeReplyMs: msOf(driver, driver.sessionStart?.replyIndex),
  promptToInitMs: initOf(driver, from) ? initOf(driver, from).ms - msOf(driver, from) : null,
  promptToResultMs: resultOf(driver, from) ? resultOf(driver, from).ms - msOf(driver, from) : null,
});
const exitOf = (attempt) => ({ opened: attempt.opened, initializeAnswered: attempt.initializeAnswered, exitCode: attempt.exit?.code ?? null, exitMs: attempt.exitMs, stdoutFrames: attempt.stdoutFrames, garbageLines: attempt.garbageLines, stderrBytes: attempt.stderrBytes });

export const SCENARIOS = {
  discover: {
    id: 'm16-discover', name: 'm16-discover', turns: 0,
    title: "What the `initialize` reply reports under a chat session's arguments, with no model named",
    successCondition: 'The reply, its key names, the permission mode it names and whether it names the tools offered (K14); a model and an effort for the other scenarios',
    async run(ctx) {
      const driver = await ctx.open({ launch: { model: null, effort: null } });
      const reply = driver.initializeReply ?? {};
      const models = Array.isArray(reply.models) ? reply.models : [];
      const levels = (m) => (Array.isArray(m?.supportedEffortLevels) ? m.supportedEffortLevels : []);
      const pick = models.find((m) => /sonnet/i.test(String(m.value)) && levels(m).includes('low')) ?? models.find((m) => levels(m).includes('low')) ?? models[0] ?? null;
      const other = models.find((m) => /haiku/i.test(String(m.value))) ?? models.find((m) => m !== pick) ?? null;
      // An idle session: nothing but the reply is expected until a prompt is written.
      await sleep(3_000);
      const idle = driver.session.frames.filter((f) => f.dir === 'recv' && f.index > driver.sessionStart.replyIndex);
      if (!pick) return didNotHappen('the reply named no model', { replyKeys: Object.keys(reply).sort() });
      writeState({ model: pick.value, effort: levels(pick).includes('low') ? 'low' : null, effortB: levels(pick).includes('high') ? 'high' : levels(pick).find((l) => l !== 'low') ?? null, modelB: other?.value ?? null });
      return happened({
        replyKeys: Object.keys(reply).sort(), currentPermissionMode: reply.current_permission_mode ?? null, sessionState: reply.session_state ?? null,
        namesTools: 'tools' in reply, commands: Array.isArray(reply.commands) ? reply.commands.length : null, agents: Array.isArray(reply.agents) ? reply.agents.length : null,
        models: models.map((m) => ({ value: m.value, supportsEffort: m.supportsEffort ?? null, levels: levels(m) })),
        chosen: { model: pick.value, effort: 'low', modelB: other?.value ?? null },
        spawnToInitializeReplyMs: msOf(driver, driver.sessionStart.replyIndex), framesWhileIdle: idle.map((f) => outline(driver, f.index).find((row) => row.index === f.index)),
      }, driver.sessionStart.replyIndex);
    },
  },

  usage: {
    id: 'm16-usage', name: 'm16-usage', turns: 0,
    title: "The scratch account's usage reading, before and after the traces (run it with --again)",
    successCondition: 'One `get_usage` reply, kept as a percentage per window and nothing else',
    async run(ctx) {
      const driver = await ctx.open({ launch: { model: null, effort: null } });
      const reply = await driver.request('get_usage', { skip_behaviors: true });
      if (!reply.ok) return didNotHappen('get_usage was refused');
      return happened({ windows: claudeWindows(reply.value) }, reply.index);
    },
  },

  saved: {
    id: 'm16-saved', name: 'm16-saved', family: FAMILY, turns: 1,
    title: 'K2: a saved session with one turn, launched with a model and an effort',
    successCondition: "A saved session's first turn to its end, under the arguments of C12, C13 and C17",
    async run(ctx) {
      if (!ctx.model) return notRun('no model chosen: run --scenario discover first');
      const driver = await ctx.open();
      const from = await ctx.prompt(driver, SAVED_PROMPT);
      const end = await ctx.turnEnd(driver, from);
      const sessionId = driver.sessionIds.at(-1) ?? null;
      writeState({ savedSessionId: sessionId });
      return happened({ endStatus: end.status, isError: end.isError, initializeMode: driver.initializeReply?.current_permission_mode ?? null, init: initSummary(driver, from), result: resultSummary(driver, from), timings: timings(driver, from), textWaits: textWaits(driver, from), outline: outline(driver, from) }, end.index);
    },
  },

  resume: {
    id: 'm16-resume', name: 'm16-resume', family: FAMILY, turns: 1,
    title: 'K2, K7: `--resume` of the saved session from a second process in the same folder, timed, with a turn',
    successCondition: 'The saved session resumed in a new process, what it sends before a prompt, then a turn to its end',
    async run(ctx) {
      if (!ctx.state.savedSessionId) return notRun('no saved session: run --scenario saved first');
      const driver = await ctx.open({ launch: { resume: ctx.state.savedSessionId } });
      // What a resumed session sends by itself, before any prompt (K7).
      await sleep(4_000);
      const beforePrompt = driver.session.frames.filter((f) => f.dir === 'recv' && f.index > driver.sessionStart.replyIndex).map((f) => outline(driver, f.index).find((row) => row.index === f.index));
      const from = await ctx.prompt(driver, RESUME_PROMPT);
      const end = await ctx.turnEnd(driver, from);
      const init = initOf(driver, from)?.frame ?? null;
      return happened({
        endStatus: end.status, isError: end.isError, initNamesTheResumedId: init?.session_id === ctx.state.savedSessionId, sessionIdsSeen: driver.sessionIds.length,
        initializeMode: driver.initializeReply?.current_permission_mode ?? null, initializeSessionState: driver.initializeReply?.session_state ?? null,
        framesBeforeThePrompt: beforePrompt, init: initSummary(driver, from), result: resultSummary(driver, from), timings: timings(driver, from),
        keptItsContext: /biscuit/i.test(ownText(driver, from)), toolCalls: driver.events(from).filter((e) => e.kind === 'tool-call').length, outline: outline(driver, from),
      }, end.index);
    },
  },

  failures: {
    id: 'm16-failures', name: 'm16-resume-failures', family: FAMILY, turns: 1, atMost: true,
    title: 'K3: a resume of an id that does not exist, one from another folder, and launches that fail otherwise',
    successCondition: 'Each launch with its exit code, its time and what it wrote to stdout; a prompt only if the resume from another folder stays up',
    async run(ctx) {
      if (!ctx.state.savedSessionId) return notRun('no saved session: run --scenario saved first');
      const notes = {};
      const attempt = async (label, launch, cwd) => {
        const tried = await ctx.tryOpen({ label, launch, ...(cwd ? { cwd } : {}) });
        // A launch that stays up says nothing more by itself: give it a moment, then look again.
        if (tried.opened) await sleep(1_500);
        const row = { ...exitOf(tried), stayedUp: tried.opened && !tried.driver.tree?.rootExited };
        return { tried, row };
      };
      const missing = await attempt('missing', { resume: randomUUID() });
      notes.missingId = missing.row;
      await ctx.close(missing.tried.driver);

      const elsewhere = await attempt('other-folder', { resume: ctx.state.savedSessionId }, ctx.other);
      notes.fromAnotherFolder = elsewhere.row;
      if (elsewhere.row.stayedUp) {
        // It did not fail at launch: one prompt shows which session it is, and whether it has the conversation.
        const from = await ctx.prompt(elsewhere.tried.driver, RESUME_PROMPT);
        const end = await ctx.turnEnd(elsewhere.tried.driver, from);
        const init = initOf(elsewhere.tried.driver, from)?.frame ?? null;
        notes.fromAnotherFolder.turn = { endStatus: end.status, isError: end.isError, initNamesTheResumedId: init?.session_id === ctx.state.savedSessionId, keptItsContext: /biscuit/i.test(ownText(elsewhere.tried.driver, from)), outline: outline(elsewhere.tried.driver, from) };
      }
      await ctx.close(elsewhere.tried.driver);

      const malformed = await attempt('malformed', { resume: 'not-a-session-id' });
      notes.malformedId = malformed.row;
      await ctx.close(malformed.tried.driver);

      const badMode = await attempt('bad-mode', { permissionMode: 'no-such-mode' });
      notes.unknownPermissionMode = badMode.row;
      await ctx.close(badMode.tried.driver);

      const badFlag = await attempt('bad-flag', { extra: ['--no-such-flag'] });
      notes.unknownFlag = badFlag.row;
      await ctx.close(badFlag.tried.driver);

      const codes = [notes.missingId, notes.fromAnotherFolder, notes.malformedId, notes.unknownPermissionMode, notes.unknownFlag].map((row) => row.exitCode);
      notes.exitCodes = codes;
      if (notes.missingId.stayedUp) return didNotHappen('a resume of an id that does not exist stayed up', notes);
      return happened(notes);
    },
  },

  effort: {
    id: 'm16-effort', name: 'm16-effort', family: FAMILY, turns: 1,
    title: 'K4: an effort changed with `apply_flag_settings` in a saved session, and what a resumed process then runs with',
    successCondition: "The change in force for its process, a turn under it, then two resumes: one naming no effort, one naming the launch's",
    async run(ctx) {
      if (!ctx.state.savedSessionId) return notRun('no saved session: run --scenario saved first');
      if (!ctx.effort) return notRun('the chosen model reports no effort level');
      const applied = async (driver) => { const reply = await driver.getSettings(); return reply.ok ? reply.value?.applied?.effort ?? null : `refused`; };
      const settingsAtStart = ctx.settingsNow();

      // What a session runs with when no effort is named: a resume that names none must be told
      // from it, so the level changed to is neither this one nor the launch's.
      const fresh = await ctx.open({ label: 'fresh-no-effort', launch: { effort: null } });
      const defaultEffort = await applied(fresh);
      await ctx.close(fresh);
      const other = ['medium', 'high', 'xhigh'].find((level) => level !== ctx.effort && level !== defaultEffort);

      const first = await ctx.open({ label: 'change', launch: { resume: ctx.state.savedSessionId } });
      const atLaunch = await applied(first);
      const change = await first.setEffort(other);
      const afterChange = await applied(first);
      const from = await ctx.prompt(first, 'Reply with the single word ok. Use no tools.');
      const end = await ctx.turnEnd(first, from);
      const afterTurn = await applied(first);
      await ctx.close(first);
      const settingsAfterChange = ctx.settingsNow();

      const second = await ctx.open({ label: 'resume-no-effort', launch: { resume: ctx.state.savedSessionId, effort: null } });
      const resumedWithoutEffort = await applied(second);
      await ctx.close(second);

      const third = await ctx.open({ label: 'resume-launch-effort', launch: { resume: ctx.state.savedSessionId } });
      const resumedWithLaunchEffort = await applied(third);
      await ctx.close(third);

      const same = JSON.stringify(settingsAtStart) === JSON.stringify(ctx.settingsNow()) && JSON.stringify(settingsAtStart) === JSON.stringify(settingsAfterChange);
      return happened({
        launchEffort: ctx.effort, appliedWhenNoneIsNamed: defaultEffort, changedTo: other, changeAccepted: change.ok, appliedAtLaunch: atLaunch, appliedAfterChange: afterChange, appliedAfterTurn: afterTurn,
        endStatus: end.status, resumedNamingNoEffort: resumedWithoutEffort, resumedNamingLaunchEffort: resumedWithLaunchEffort,
        settingsFilesUnchanged: same, settingsFiles: ctx.settingsNow(), initEffortField: 'effort' in (initOf(first, from)?.frame ?? {}),
      }, end.index);
    },
  },

  parallel: {
    id: 'm16-parallel', name: 'm16-parallel', turns: 2,
    title: 'K5: two processes running turns at once in one folder',
    successCondition: 'Two sessions in one folder, each a process of its own, their turns overlapping and both ending completed',
    async run(ctx) {
      if (!ctx.model) return notRun('no model chosen: run --scenario discover first');
      const a = await ctx.open({ label: 'a' });
      const b = await ctx.open({ label: 'b' });
      const startedAt = Date.now();
      const fromA = await ctx.prompt(a, 'Read notes-1.txt in the current folder and tell me in one sentence what it says.');
      const fromB = await ctx.prompt(b, 'Read notes-2.txt in the current folder and tell me in one sentence what it says.');
      const clock = (driver, index) => driver.tree.spawnedAt + (driver.session.frames.find((f) => f.index === index)?.ms ?? 0) - startedAt;
      const [endA, endB] = await Promise.all([ctx.turnEnd(a, fromA), ctx.turnEnd(b, fromB)]);
      const span = (driver, from, end) => ({ initAtMs: initOf(driver, from) ? clock(driver, initOf(driver, from).index) : null, endAtMs: clock(driver, end.index), endStatus: end.status, isError: end.isError });
      const spanA = span(a, fromA, endA);
      const spanB = span(b, fromB, endB);
      const overlapped = spanA.initAtMs !== null && spanB.initAtMs !== null && spanA.initAtMs < spanB.endAtMs && spanB.initAtMs < spanA.endAtMs;
      const notes = { a: spanA, b: spanB, overlapped, differentSessions: a.sessionIds.at(-1) !== b.sessionIds.at(-1), outlineA: outline(a, fromA), outlineB: outline(b, fromB) };
      if (!overlapped) return didNotHappen('the two turns did not overlap', notes);
      return happened(notes);
    },
  },

  named: {
    id: 'm16-named', name: 'm16-named', turns: 2,
    title: 'K6: a session fat-g names with `--session-id`, its resume, and a resume of one so named that had no turn',
    successCondition: 'A named session whose `init` names that id, its resume with its context, and what a resume of a named session without a turn does',
    async run(ctx) {
      if (!ctx.model) return notRun('no model chosen: run --scenario discover first');
      const withTurn = randomUUID();
      const noTurn = randomUUID();
      const notes = {};

      const first = await ctx.open({ label: 'named', launch: { sessionId: withTurn } });
      const from = await ctx.prompt(first, 'Remember the word LANTERN. Reply with the single word ok. Use no tools.');
      const end = await ctx.turnEnd(first, from);
      notes.named = { endStatus: end.status, isError: end.isError, initNamesTheGivenId: initOf(first, from)?.frame.session_id === withTurn, timings: timings(first, from) };
      await ctx.close(first);

      const idle = await ctx.tryOpen({ label: 'named-no-turn', launch: { sessionId: noTurn } });
      notes.namedWithoutATurn = { opened: idle.opened };
      if (idle.opened) await sleep(1_000);
      await ctx.close(idle.driver);

      const resumeIdle = await ctx.tryOpen({ label: 'resume-no-turn', launch: { resume: noTurn } });
      if (resumeIdle.opened) await sleep(1_500);
      notes.resumeOfOneWithoutATurn = { ...exitOf(resumeIdle), stayedUp: resumeIdle.opened && !resumeIdle.driver.tree?.rootExited };
      await ctx.close(resumeIdle.driver);

      // The same id named again for a launch, once with no turn behind it and once with one.
      const againIdle = await ctx.tryOpen({ label: 'named-again-no-turn', launch: { sessionId: noTurn } });
      if (againIdle.opened) await sleep(1_500);
      notes.sameIdNamedAgainAfterNoTurn = { ...exitOf(againIdle), stayedUp: againIdle.opened && !againIdle.driver.tree?.rootExited };
      await ctx.close(againIdle.driver);

      const againUsed = await ctx.tryOpen({ label: 'named-again-used', launch: { sessionId: withTurn } });
      if (againUsed.opened) await sleep(1_500);
      notes.sameIdNamedAgainAfterATurn = { ...exitOf(againUsed), stayedUp: againUsed.opened && !againUsed.driver.tree?.rootExited };
      await ctx.close(againUsed.driver);

      const resumed = await ctx.open({ label: 'resume-named', launch: { resume: withTurn } });
      const from2 = await ctx.prompt(resumed, 'Which word did I ask you to remember? Reply with that word only. Use no tools.');
      const end2 = await ctx.turnEnd(resumed, from2);
      notes.resumeOfTheNamed = { endStatus: end2.status, isError: end2.isError, initNamesTheGivenId: initOf(resumed, from2)?.frame.session_id === withTurn, keptItsContext: /lantern/i.test(ownText(resumed, from2)), timings: timings(resumed, from2) };
      if (!notes.named.initNamesTheGivenId) return didNotHappen("the first turn's init did not name the id given", notes);
      return happened(notes, end2.index);
    },
  },

  replay: {
    id: 'm16-replay', name: 'm16-replay', family: FAMILY, turns: 1,
    title: 'K7: what a resumed session sends of its earlier conversation with `--replay-user-messages`',
    successCondition: 'The frames a resumed session sends before a prompt, then a prompt with an id of its own and its echo',
    async run(ctx) {
      if (!ctx.state.savedSessionId) return notRun('no saved session: run --scenario saved first');
      const driver = await ctx.open({ launch: { resume: ctx.state.savedSessionId, replay: true } });
      await sleep(5_000);
      const beforePrompt = driver.session.frames.filter((f) => f.dir === 'recv' && f.index > driver.sessionStart.replyIndex).map((f) => outline(driver, f.index).find((row) => row.index === f.index));
      const uuid = randomUUID();
      const from = await ctx.prompt(driver, 'Reply with the single word ok. Use no tools.', { uuid });
      const end = await ctx.turnEnd(driver, from);
      await sleep(1_000);
      const users = framesOf(driver, 'user', from).filter((f) => f.frame.parent_tool_use_id == null);
      const echo = users.find((f) => f.frame.uuid === uuid) ?? null;
      const init = initOf(driver, from);
      return happened({
        endStatus: end.status, framesBeforeThePrompt: beforePrompt,
        userFramesInTheTurn: users.map((f) => ({ index: f.index, ours: f.frame.uuid === uuid, isReplay: f.frame.isReplay ?? null, keys: Object.keys(f.frame).sort() })),
        echoCarriesOurId: Boolean(echo), echoBeforeInit: echo && init ? echo.index < init.index : null, echoMsAfterPrompt: echo ? echo.ms - msOf(driver, from) : null,
        earlierConversationReplayed: users.filter((f) => f.frame.uuid !== uuid).length + framesOf(driver, 'assistant', 0).filter((f) => f.index < from).length,
        outline: outline(driver, from, { sent: [uuid] }),
      }, end.index);
    },
  },
};
