// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// M15 spike (C97, C101; M14, C117; Design 1): the two worker cases M10 did not trace.
//
//   node spikes/m15/workers.mjs --scenario interrupt|outlive [--confirm-turns 1] [--again]
//
// interrupt: a Stop while a worker runs. What the interrupt does to the worker, and in what order
//            the worker's closing item and its own turn's end come (C91, C101).
// outlive:   a worker still running when its turn ends, followed until that worker ends (C99, C100).
//
// A case the model does not produce is recorded as did not happen, after its three runs.
import { sleep } from '../m10/lib/deadlines.mjs';
import { isMain } from '../m10/lib/paths.mjs';
import { runSpike } from '../m10/lib/spike.mjs';
import { chooseScenario, didNotHappen, happened, notRun, outline, runScenario } from './lib/common.mjs';

/** The frames that say what became of the workers, in the order they came. */
function workerFrames(driver, from) {
  return outline(driver, from).filter((row) => row.item === 'subAgentActivity' || row.item === 'collabAgentToolCall' || (row.thread && row.thread !== 'session' && ['turn/started', 'turn/completed', 'thread/status/changed', 'thread/started', 'thread/closed'].includes(row.method)) || (row.thread === 'session' && ['turn/completed', 'thread/status/changed'].includes(row.method)));
}

const workerTurnEnds = (driver, from) => driver.session.frames.filter((f) => f.dir === 'recv' && f.index >= from && f.frame?.method === 'turn/completed' && f.frame.params?.threadId && f.frame.params.threadId !== driver.threadId);
const closingItems = (driver, from) => driver.session.frames.filter((f) => f.dir === 'recv' && f.index >= from && f.frame?.params?.item?.type === 'subAgentActivity' && ['completed', 'interrupted'].includes(f.frame.params.item.kind));

/** Waits up to `ms` for a worker's own turn to end, looking every quarter second. */
async function followWorker(driver, from, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (workerTurnEnds(driver, from).length > 0) return true;
    if (driver.tree?.rootExited) return false;
    await sleep(250);
  }
  return workerTurnEnds(driver, from).length > 0;
}

const SCENARIOS = {
  interrupt: {
    id: 'm15-worker-interrupt', name: 'm15-worker-interrupt', turns: 1, tools: ['sub-agent'],
    title: 'An interrupt while a worker runs',
    successCondition: "A worker's start, an interrupt while it runs, then the session's turn ending interrupted",
    async run(ctx) {
      const driver = await ctx.open();
      const started = await ctx.startThread(driver);
      if (!started.ok) return didNotHappen('thread/start was refused');
      if (!driver.sessionStart.check.passed) return notRun('the session-start reply differed from the request (C21)', { rows: driver.sessionStart.check.rows });
      const from = driver.nextIndex;
      await ctx.prompt(driver, 'Spawn a sub-agent and give it this task: read notes-1.txt, notes-2.txt, notes-3.txt and notes-4.txt one at a time, in that order, and report what each one says. Do not read the files yourself. When the sub-agent is done, tell me in one sentence what it found.');
      const first = await ctx.wait(driver, (e) => (e.kind === 'worker-start' && e.source === 'subAgentActivity') || e.kind === 'turn-end', from);
      if (first.kind === 'turn-end') return didNotHappen('the turn ended before any worker started', { endStatus: first.status, outline: workerFrames(driver, from) });
      // Let the worker get under way: its first tool call, or its turn's start, or two seconds.
      await Promise.race([ctx.wait(driver, (e) => (e.kind === 'tool-call' && e.worker) || (e.kind === 'worker-start' && e.source === 'turn/started'), first.index).catch(() => null), sleep(2_000)]);
      const workerEndedFirst = workerTurnEnds(driver, from).length > 0;
      const interruptAt = driver.nextIndex;
      const reply = await driver.interrupt();
      const end = await ctx.turnEnd(driver, first.index);
      // The worker's own turn: does it end by itself after the interrupt? The first run of this
      // scenario waited 20 s and it did not, so 5 s here; then C91's interrupt of the worker's own
      // turn, by the id its turn/started named, and whether that ends it.
      const endedByItself = await followWorker(driver, from, 5_000);
      let workerInterrupt = null;
      if (!endedByItself) {
        const workerTurn = driver.session.frames.find((f) => f.dir === 'recv' && f.index >= from && f.frame?.method === 'turn/started' && f.frame.params?.threadId && f.frame.params.threadId !== driver.threadId);
        if (workerTurn) {
          const sentAt = driver.nextIndex;
          const answer = await driver.request('turn/interrupt', { threadId: workerTurn.frame.params.threadId, turnId: workerTurn.frame.params.turn?.id });
          workerInterrupt = { sentAtIndex: sentAt, accepted: answer.ok, errorCode: answer.ok ? null : answer.error?.code ?? null };
        } else workerInterrupt = { sent: false, why: "no turn/started named the worker's turn" };
      }
      const workerEnded = endedByItself || await followWorker(driver, from, 20_000);
      await sleep(2_000);
      const ends = workerTurnEnds(driver, from);
      const closing = closingItems(driver, from);
      const notes = {
        interruptAccepted: reply.ok, endStatus: end.status, workerEndedBeforeTheInterrupt: workerEndedFirst,
        interruptSentAtIndex: interruptAt, sessionTurnEndIndex: end.index,
        workerTurnEnds: ends.map((f) => ({ index: f.index, status: f.frame.params.turn?.status ?? null, afterSessionTurnEnd: f.index > end.index })),
        closingItems: closing.map((f) => ({ index: f.index, method: f.frame.method, kind: f.frame.params.item.kind, afterSessionTurnEnd: f.index > end.index })),
        workerTurnEndedByItselfWithin5s: endedByItself, workerInterrupt, workerTurnEndedAfterItsInterrupt: endedByItself ? null : workerEnded,
        sessionStatusAfter: driver.session.frames.filter((f) => f.dir === 'recv' && f.index > end.index && f.frame?.method === 'thread/status/changed').map((f) => ({ index: f.index, session: f.frame.params?.threadId === driver.threadId, type: f.frame.params?.status?.type ?? null })),
        closingItemBeforeWorkerTurnEnd: closing.length && ends.length ? closing[0].index < ends[0].index : null,
        outline: workerFrames(driver, from),
      };
      if (workerEndedFirst) return didNotHappen('the worker had ended before the interrupt went out', notes);
      return happened(notes, end.index);
    },
  },

  outlive: {
    id: 'm15-worker-outlive', name: 'm15-worker-outlives-turn', turns: 1, tools: ['sub-agent'],
    title: 'A worker still running when its turn ends',
    successCondition: "The session's turn ending while a worker it started still runs, then that worker's own end",
    async run(ctx) {
      const driver = await ctx.open();
      const started = await ctx.startThread(driver);
      if (!started.ok) return didNotHappen('thread/start was refused');
      if (!driver.sessionStart.check.passed) return notRun('the session-start reply differed from the request (C21)', { rows: driver.sessionStart.check.rows });
      const from = driver.nextIndex;
      await ctx.prompt(driver, 'Spawn a sub-agent and give it this task: first run the command Start-Sleep -Seconds 45, then read notes-3.txt and report what it says. Do not wait for the sub-agent and do not read the file yourself: as soon as the sub-agent has started, end your turn by telling me in one sentence that it is working in the background.');
      const end = await ctx.turnEnd(driver, from);
      const events = driver.events(from);
      const workerStart = events.find((e) => e.kind === 'worker-start' && e.source === 'subAgentActivity');
      const endsBefore = workerTurnEnds(driver, from).filter((f) => f.index < end.index);
      const closingBefore = closingItems(driver, from).filter((f) => f.index < end.index);
      const base = { endStatus: end.status, workerStarted: Boolean(workerStart), workerTurnEndedBeforeSessionTurn: endsBefore.length > 0, closingItemBeforeSessionTurnEnd: closingBefore.length > 0 };
      if (!workerStart) return didNotHappen('no worker started', { ...base, outline: workerFrames(driver, from) });
      if (endsBefore.length > 0 || closingBefore.length > 0) return didNotHappen("the worker ended before its session's turn did", { ...base, outline: workerFrames(driver, from) });
      // The turn is over and the worker is not: follow it to its own end.
      const sessionEndIndex = end.index;
      const followed = await followWorker(driver, from, 150_000);
      await sleep(3_000);
      const ends = workerTurnEnds(driver, from);
      const closing = closingItems(driver, from);
      const after = driver.session.frames.filter((f) => f.dir === 'recv' && f.index > sessionEndIndex);
      const notes = {
        ...base, workerEndedLater: followed,
        workerTurnEnds: ends.map((f) => ({ index: f.index, status: f.frame.params.turn?.status ?? null })),
        closingItems: closing.map((f) => ({ index: f.index, method: f.frame.method, kind: f.frame.params.item.kind })),
        // What the session's own thread did once its worker had ended: a new turn of its own, or nothing.
        sessionTurnsAfter: after.filter((f) => f.frame?.method === 'turn/started' && f.frame.params?.threadId === driver.threadId).length,
        sessionStatusAfter: after.filter((f) => f.frame?.method === 'thread/status/changed' && f.frame.params?.threadId === driver.threadId).map((f) => f.frame.params.status?.type ?? null),
        outline: workerFrames(driver, from),
      };
      // A turn the worker's end started on the session's thread would still be running: let it end.
      if (notes.sessionTurnsAfter > 0) await ctx.wait(driver, (e) => e.kind === 'turn-end', sessionEndIndex + 1).catch(() => null);
      return happened(notes, end.index);
    },
  },
};

if (isMain(import.meta.url)) {
  await runSpike('m15-workers', (frame) => {
    const scenario = chooseScenario('workers', SCENARIOS, frame.args);
    return scenario ? runScenario('m15-workers', scenario, frame) : 1;
  });
}
