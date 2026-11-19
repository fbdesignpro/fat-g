// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V4, V14 (docs/planning/_archive/M20b.md; C10, C12, C19–C23, C62, C69, C70): a question asked beside a Codex
// session, on the real adapter and process layer against the replay fake. The forks and the side
// threads' turns are K3's, each replayed from its capture; a fault is that capture's frame with one
// named change. No test here uses the real CLI.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type AgentEvent, AgentEventSchema } from '@shared/contracts/agent-events';
import { ASIDE_INSTRUCTIONS, withEarlier } from '@shared/contracts/aside';
import type { AsideExchange, AsideRequest } from '@shared/provider-kit/sessions';
import type { CodexSession } from '../../src/main/providers/codex/session';
import { codexHarness, eventually, type Harness, PROMPTS, promptOf, type ThreadEntry, watch, type Watched } from './harness';

let harness: Harness | undefined;
afterEach(async () => { await harness?.dispose(); harness = undefined; });
const MODEL = 'gpt-6-astra';
const start = (h: Harness) => watch(h.facet.start({ folder: h.project, model: MODEL, effort: 'low', speed: null, otherFolders: [], mode: 'read-only', processKey: 'process-1' }));
const resume = (h: Harness, reference: string) => watch(h.facet.resume({ folder: h.project, model: MODEL, effort: 'low', speed: null, otherFolders: [], mode: 'read-only', processKey: 'process-1', reference }));
const counts = (s: Watched) => (s.session as CodexSession).counts;

interface Captured { readonly index: number; readonly dir: string; readonly frame: { id?: number; method?: string; params?: { threadId?: string; input?: { text: string }[]; item?: { type?: string; text?: string; phase?: string } }; result?: { thread?: { id?: string } } } }
const frames = (name: string): Captured[] => (JSON.parse(readFileSync(path.resolve('tests/fixtures/codex/captures', `${name}.json`), 'utf8')) as { frames: Captured[] }).frames;
/** The side threads a capture's forks made, by alias. */
function children(name: string): Set<string> {
  const all = frames(name);
  const forks = all.filter((entry) => entry.dir === 'send' && entry.frame.method === 'thread/fork').map((entry) => entry.frame.id);
  return new Set(all.flatMap((entry) => (entry.dir === 'recv' && entry.frame.method === undefined && forks.includes(entry.frame.id) && typeof entry.frame.result?.thread?.id === 'string' ? [entry.frame.result.thread.id] : [])));
}
/** A capture's question to a side thread, with the final answer that thread gave it. */
function childTurn(name: string, nth = 0): { readonly question: string; readonly answer: string | null } {
  const all = frames(name);
  const threads = children(name);
  const sent = all.filter((entry) => entry.dir === 'send' && entry.frame.method === 'turn/start' && threads.has(entry.frame.params?.threadId ?? ''))[nth];
  const question = sent?.frame.params?.input?.[0]?.text;
  if (sent === undefined || typeof question !== 'string') throw new Error(`${name} has no side thread turn ${nth}`);
  const later = all.filter((entry) => entry.index > sent.index && entry.dir === 'recv' && entry.frame.params?.threadId === sent.frame.params?.threadId);
  const answer = later.find((entry) => entry.frame.method === 'item/completed' && entry.frame.params?.item?.type === 'agentMessage' && entry.frame.params.item.phase === 'final_answer');
  return { question, answer: answer?.frame.params?.item?.text ?? null };
}

const ASIDE = (n: number): string => `a51de000-0000-4000-8000-00000000000${n}`;
const TURN = (n: number, turn = 1): string => `aside-${n}-turn-${turn}`;
/** Asks aside `n` a question, as main does: its ids, its earlier exchanges, and the session's newest ended turn. */
function ask(s: Watched, n: number, text: string, extra: { readonly history?: readonly AsideExchange[]; readonly throughTurn?: string | null; readonly turn?: number } = {}): AsideRequest {
  const turn = extra.turn ?? 1;
  const request: AsideRequest = { asideId: ASIDE(n), turnId: TURN(n, turn), text, messageId: `00000000-0000-4000-8000-0000000000${turn}${n}`, history: extra.history ?? [], throughTurn: extra.throughTurn ?? null, effort: 'low', speed: null };
  s.session.ask?.(request);
  return request;
}
const named = (event: AgentEvent): string | undefined => ('asideId' in event ? event.asideId : undefined);
const ofAside = (s: Watched, n: number): AgentEvent[] => s.events.filter((event) => named(event) === ASIDE(n));
const own = (s: Watched): AgentEvent[] => s.events.filter((event) => named(event) === undefined);
const kinds = (events: readonly AgentEvent[]): string[] => events.map((event) => (event.type === 'notice' ? `notice:${event.kind}` : event.type));
const asideEnded = (s: Watched, n: number, turn = 1) => s.ended(TURN(n, turn));
const asideStarted = (s: Watched, n: number, turn = 1) => s.until((event) => event.type === 'turn-started' && event.turnId === TURN(n, turn));
interface Asked extends ThreadEntry {
  readonly forks?: readonly Record<string, unknown>[];
  readonly asides?: readonly { readonly capture: string; readonly text: string; readonly model: string | null; readonly effort: string | null; readonly client: string | null }[];
  readonly asideInterrupts?: readonly { readonly active: boolean; readonly inputOpen: boolean }[];
}
const only = (h: Harness): { readonly id: string; readonly thread: Asked } => {
  const entries = Object.entries(h.threads());
  if (entries.length !== 1) throw new Error(`expected one thread, found ${entries.length}`);
  const [id, thread] = entries[0] as [string, Asked];
  return { id, thread };
};
/** A session that has held a turn, with Codex's own id for it: what a fork is made through (C19). */
async function started(h: Harness): Promise<{ readonly s: Watched; readonly through: string }> {
  const s = start(h);
  s.send(PROMPTS.t1);
  await s.ended('turn-1');
  const took = s.events.find((event) => event.type === 'turn-started');
  if (took?.type !== 'turn-started' || took.providerTurnId === undefined) throw new Error('the turn was not named');
  return { s, through: took.providerTurnId };
}

describe('an aside’s side thread (V4; C19, C20, C69)', () => {
  it('is forked with exactly the fields the decision names, through the newest ended turn, and answers under the aside alone', async () => {
    const h = harness = await codexHarness();
    const { s, through } = await started(h);
    const seed = childTurn('m20b-fork-followup');
    const before = s.events.length;
    const request = ask(s, 1, seed.question, { throughTurn: through });
    expect(await asideEnded(s, 1)).toEqual({ type: 'turn-ended', turnId: TURN(1), asideId: ASIDE(1), outcome: 'completed', reported: true });
    const { id, thread } = only(h);
    // The fork's fields, and no other: never `config`, never `baseInstructions` (C19); the chat's speed tier, standard here (decision 0018).
    expect(thread.forks).toEqual([{ threadId: id, lastTurnId: through, ephemeral: true, excludeTurns: true, cwd: h.project, sandbox: 'read-only', approvalPolicy: 'never', developerInstructions: ASIDE_INSTRUCTIONS, model: MODEL, serviceTier: 'default' }]);
    // Its turn carries the record's model and effort, and the message's id; its question is as it was asked.
    expect(thread.asides).toEqual([{ capture: 'm20b-fork-followup', text: seed.question, model: MODEL, effort: 'low', client: request.messageId }]);
    // Every event since names the aside and none a worker, and each passes the schema.
    const events = s.events.slice(before);
    expect(events).toEqual(ofAside(s, 1));
    for (const event of events) {
      expect(AgentEventSchema.safeParse(event).success).toBe(true);
      expect(event).not.toHaveProperty('workerId');
    }
    expect(events[0]).toMatchObject({ type: 'turn-started', turnId: TURN(1), asideId: ASIDE(1) });
    // The answer as it is written, then whole.
    const deltas = events.flatMap((event) => (event.type === 'message-delta' ? [event] : []));
    const whole = events.findLast((event) => event.type === 'message');
    expect(whole).toMatchObject({ role: 'assistant', phase: 'final', text: seed.answer, turnId: TURN(1) });
    expect(deltas.filter((delta) => whole?.type === 'message' && delta.itemId === whole.itemId).map((delta) => delta.text).join('')).toBe(seed.answer);
    // The session's own thread ran no second turn, and its process took no second launch.
    expect(thread.turns).toHaveLength(1);
    expect(thread.launches).toHaveLength(1);
    expect(counts(s).dropped['other-thread']).toBe(0);
  });

  it('is forked without `lastTurnId` while no turn of the session’s has ended (C69)', async () => {
    const h = harness = await codexHarness();
    const { s } = await started(h);
    ask(s, 1, childTurn('m20b-fork-seed').question, { throughTurn: null });
    expect((await asideEnded(s, 1)).outcome).toBe('completed');
    const [fork] = only(h).thread.forks ?? [];
    expect(fork).not.toHaveProperty('lastTurnId');
    expect(Object.keys(fork ?? {}).sort()).toEqual(['approvalPolicy', 'cwd', 'developerInstructions', 'ephemeral', 'excludeTurns', 'model', 'sandbox', 'serviceTier', 'threadId']);
  });

  it('shows what the side thread read as an activity of the aside’s, never the session’s own (C11, C20)', async () => {
    const h = harness = await codexHarness();
    const { s, through } = await started(h);
    const read = childTurn('m20b-fork-read');
    const before = own(s).length;
    ask(s, 1, read.question, { throughTurn: through });
    expect((await asideEnded(s, 1)).outcome).toBe('completed');
    const activity = ofAside(s, 1).filter((event) => event.type === 'activity-started' || event.type === 'activity-ended');
    expect(kinds(activity)).toEqual(['activity-started', 'activity-ended']);
    expect(activity[0]).toMatchObject({ turnId: TURN(1), asideId: ASIDE(1) });
    expect(activity[1]).toMatchObject({ status: 'completed' });
    expect(own(s)).toHaveLength(before);
    expect(ofAside(s, 1).findLast((event) => event.type === 'message')).toMatchObject({ text: read.answer });
  });

  it('takes a follow-up on the same side thread while the process lives: one fork, and the question as it was typed (C22)', async () => {
    const h = harness = await codexHarness();
    const { s, through } = await started(h);
    const [first, second] = [childTurn('m20b-fork-followup', 0), childTurn('m20b-fork-followup', 1)];
    ask(s, 1, first.question, { throughTurn: through });
    await asideEnded(s, 1);
    ask(s, 1, second.question, { throughTurn: through, turn: 2, history: [{ question: first.question, response: first.answer ?? '' }] });
    expect((await asideEnded(s, 1, 2)).outcome).toBe('completed');
    const { thread } = only(h);
    expect(thread.forks).toHaveLength(1);
    expect(thread.asides?.map((turn) => turn.text)).toEqual([first.question, second.question]);
    expect(ofAside(s, 1).findLast((event) => event.type === 'message')).toMatchObject({ turnId: TURN(1, 2), text: second.answer });
  });

  it('forks again once the process has ended, with the earlier exchanges before the question (C22)', async () => {
    const h = harness = await codexHarness();
    const { s, through } = await started(h);
    const first = childTurn('m20b-fork-followup', 0);
    ask(s, 1, first.question, { throughTurn: through });
    await asideEnded(s, 1);
    await s.session.close();
    const again = resume(h, s.reference() as string);
    const history = [{ question: first.question, response: first.answer ?? '' }];
    const typed = 'What passage was I asking about earlier in this side conversation, and what is the function in src/tides.js called? One sentence.';
    ask(again, 1, typed, { throughTurn: through, turn: 2, history });
    expect((await asideEnded(again, 1, 2)).outcome).toBe('completed');
    const { thread } = only(h);
    expect(thread.forks).toHaveLength(2);
    expect(thread.launches).toHaveLength(2);
    // The form K3 sent, which its side thread answered knowing both: the fake chose that capture by it.
    expect(thread.asides?.[1]).toMatchObject({ capture: 'm20b-fork-again', text: withEarlier(history, typed) });
    expect(thread.asides?.[1]?.text).toBe(childTurn('m20b-fork-again').question);
    // No turn of the session's own was started in the new process: all it says of its own is the mode
    // its resume reply confirmed (M22, C2), which is the process's and no turn's.
    expect(thread.turns).toHaveLength(1);
    expect(own(again)).toEqual([{ type: 'in-force', mode: 'read-only' }]);
  });
});

describe('an aside beside the session’s turn, and two at once (V4; C17, C21)', () => {
  it('runs beside a turn of the session’s, each frame read for its thread, and leaves that turn as it would be', async () => {
    const h = harness = await codexHarness();
    const { s, through } = await started(h);
    s.send(promptOf('m20b-fork-during'), 2);
    await s.until((event) => event.type === 'turn-started' && event.turnId === 'turn-2');
    const during = childTurn('m20b-fork-during');
    const [first] = [childTurn('m20b-fork-two', 0)];
    ask(s, 1, during.question, { throughTurn: through });
    ask(s, 2, first.question, { throughTurn: through });
    expect((await asideEnded(s, 1)).outcome).toBe('completed');
    expect((await asideEnded(s, 2)).outcome).toBe('completed');
    const end = await s.ended('turn-2');
    expect(end).toMatchObject({ outcome: 'completed', reported: true });
    expect(ofAside(s, 1).findLast((event) => event.type === 'message')).toMatchObject({ text: during.answer });
    expect(ofAside(s, 2).findLast((event) => event.type === 'message')).toMatchObject({ text: first.answer });
    // The session's own events name no aside, and its turn has its own answer.
    const mine = own(s).filter((event) => 'turnId' in event && event.turnId === 'turn-2');
    expect(mine.some((event) => event.type === 'message' && event.role === 'assistant' && event.phase === 'final')).toBe(true);
    expect(only(h).thread.forks).toHaveLength(2);
    expect(counts(s).dropped['other-thread']).toBe(0);
    expect(counts(s).dropped['other-turn']).toBe(0);
  });

  it('the session’s own Stop interrupts no side thread (C12, C70)', async () => {
    const h = harness = await codexHarness();
    const { s, through } = await started(h);
    // K3's long answer, which its capture shows interrupted: the fake plays it to there, and waits.
    ask(s, 1, childTurn('m20b-fork-two', 1).question, { throughTurn: through });
    await s.until((event) => event.type === 'message-delta' && named(event) === ASIDE(1) && event.text !== '');
    s.send(PROMPTS.t4, 2);
    await s.until((event) => event.type === 'action-changed' && event.turnId === 'turn-2');
    s.session.stop();
    expect(await s.ended('turn-2')).toMatchObject({ outcome: 'interrupted', reported: true });
    const { thread } = only(h);
    expect(thread.interrupts).toEqual([{ inputOpen: true, worker: false }]);
    expect(thread.asideInterrupts).toBeUndefined();
    // The aside still runs, and its own Stop then ends it by Codex's word.
    expect(ofAside(s, 1).some((event) => event.type === 'turn-ended')).toBe(false);
    s.session.stopAside?.(ASIDE(1));
    expect(await asideEnded(s, 1)).toEqual({ type: 'turn-ended', turnId: TURN(1), asideId: ASIDE(1), outcome: 'interrupted', reported: true });
    expect(only(h).thread.asideInterrupts).toEqual([{ active: true, inputOpen: true }]);
  });
});

describe('an aside’s Stop (V4; C12, C70)', () => {
  it('interrupts the side thread’s turn once it is named and started, and the process takes what comes next', async () => {
    const h = harness = await codexHarness();
    const { s, through } = await started(h);
    const processes = h.running().length;
    ask(s, 1, childTurn('m20b-fork-two', 1).question, { throughTurn: through });
    await s.until((event) => event.type === 'message-delta' && named(event) === ASIDE(1) && event.text !== '');
    s.session.stopAside?.(ASIDE(1));
    expect(await asideEnded(s, 1)).toMatchObject({ outcome: 'interrupted', reported: true });
    expect(kinds(ofAside(s, 1)).filter((kind) => kind.startsWith('notice'))).toEqual([]);
    // No process was ended for it (C70).
    expect(h.running()).toHaveLength(processes);
    // The side thread is still there: the aside's next question goes to it, with no second fork.
    ask(s, 1, childTurn('m20b-fork-followup', 1).question, { throughTurn: through, turn: 2 });
    expect((await asideEnded(s, 1, 2)).outcome).toBe('completed');
    expect(only(h).thread.forks).toHaveLength(1);
  });

  it('pressed before the fork’s reply, sends nothing more and ends the aside at once', async () => {
    const h = harness = await codexHarness();
    const { s, through } = await started(h);
    h.control({ hang: 'fork' });
    ask(s, 1, childTurn('m20b-fork-followup').question, { throughTurn: through });
    await eventually(() => (only(h).thread.forks ?? []).length === 1, 10_000, 'the fork reaching the fake');
    s.session.stopAside?.(ASIDE(1));
    expect(await asideEnded(s, 1)).toEqual({ type: 'turn-ended', turnId: TURN(1), asideId: ASIDE(1), outcome: 'interrupted', reported: false });
    expect(kinds(ofAside(s, 1))).toEqual(['turn-ended']);
    expect(only(h).thread.asides).toBeUndefined();
    expect(only(h).thread.asideInterrupts).toBeUndefined();
  });

  it('ends the aside alone when the interrupt is not confirmed, drops what still comes, and forks anew at its next question', async () => {
    const h = harness = await codexHarness({ timings: { stopMs: 60 }, env: { FATG_SMOKE_CODEX_GAP_MS: '15' } });
    const { s, through } = await started(h);
    const processes = h.running().length;
    h.control({ hang: 'childStop' });
    // An answer that is still being written when the Stop comes, and goes on after it.
    ask(s, 1, childTurn('m20b-fork-read').question, { throughTurn: through });
    await asideStarted(s, 1);
    await s.until((event) => named(event) === ASIDE(1) && event.type !== 'turn-started');
    s.session.stopAside?.(ASIDE(1));
    expect(await asideEnded(s, 1)).toEqual({ type: 'turn-ended', turnId: TURN(1), asideId: ASIDE(1), outcome: 'interrupted', reported: false });
    expect(kinds(ofAside(s, 1)).at(-2)).toBe('notice:stop-unconfirmed');
    const after = ofAside(s, 1).length;
    // The side thread's later frames are dropped, and counted; none becomes an event (C70).
    await eventually(() => counts(s).dropped['ended-aside'] > 0, 10_000, 'the late frames being counted');
    expect(ofAside(s, 1)).toHaveLength(after);
    // The process was never ended for it.
    expect(h.running()).toHaveLength(processes);
    h.control({});
    ask(s, 1, childTurn('m20b-fork-followup', 1).question, { throughTurn: through, turn: 2 });
    expect((await asideEnded(s, 1, 2)).outcome).toBe('completed');
    expect(only(h).thread.forks).toHaveLength(2);
  });
});

describe('what a fork, or a side thread’s turn, can come to (V4, V14; C19, C62)', () => {
  it.each([['sandbox'], ['network'], ['policy']])('forkOther %s: a side thread that is not read-only is sent no turn', async (other) => {
    const h = harness = await codexHarness();
    const { s, through } = await started(h);
    h.control({ forkOther: other });
    ask(s, 1, childTurn('m20b-fork-followup').question, { throughTurn: through });
    expect(await asideEnded(s, 1)).toEqual({ type: 'turn-ended', turnId: TURN(1), asideId: ASIDE(1), outcome: 'failed', reported: false, failure: 'not-read-only' });
    expect(kinds(ofAside(s, 1))).toEqual(['notice:not-read-only', 'turn-ended']);
    expect(only(h).thread.asides).toBeUndefined();
    // The session is as it was: its process is there, and its next prompt runs.
    h.control({});
    s.send(PROMPTS.t1, 2);
    expect((await s.ended('turn-2')).outcome).toBe('completed');
    expect(only(h).thread.launches).toHaveLength(1);
  });

  it('forkRefused: the aside’s question is not answered, with its step, and the session goes on', async () => {
    const h = harness = await codexHarness();
    const { s, through } = await started(h);
    h.control({ forkRefused: 1 });
    ask(s, 1, childTurn('m20b-fork-followup').question, { throughTurn: through });
    expect(await asideEnded(s, 1)).toMatchObject({ outcome: 'failed', reported: false, failure: 'start-failed' });
    expect(ofAside(s, 1)[0]).toMatchObject({ type: 'notice', kind: 'start-failed', step: 'open' });
    ask(s, 2, childTurn('m20b-fork-followup').question, { throughTurn: through });
    expect((await asideEnded(s, 2)).outcome).toBe('completed');
  });

  it('a fork reply over the line limit is dropped, and reads as a fork that was not answered', async () => {
    const h = harness = await codexHarness({ timings: { openMs: 300 } });
    const { s, through } = await started(h);
    h.control({ oversize: 'forkReply' });
    ask(s, 1, childTurn('m20b-fork-followup').question, { throughTurn: through });
    expect(await asideEnded(s, 1)).toMatchObject({ outcome: 'failed', reported: false, failure: 'start-failed' });
    // The fork's deadline and the line's drop are two things: on a slow machine the deadline is
    // first, the line still arriving. The process is left as it is, so the drop is counted when the
    // line has passed its limit, whichever came first.
    await eventually(() => counts(s).dropped.oversized === 1, 10_000, 'the oversized reply being dropped and counted');
    expect(counts(s).dropped.oversized).toBe(1);
    expect(only(h).thread.asides).toBeUndefined();
  });

  it('childTurnFailed: the side thread’s own failed end fails the aside’s turn, with its notice', async () => {
    const h = harness = await codexHarness();
    const { s, through } = await started(h);
    h.control({ childTurnFailed: true });
    ask(s, 1, childTurn('m20b-fork-followup').question, { throughTurn: through });
    expect(await asideEnded(s, 1)).toEqual({ type: 'turn-ended', turnId: TURN(1), asideId: ASIDE(1), outcome: 'failed', reported: true, failure: 'turn-failed' });
    expect(kinds(ofAside(s, 1)).at(-2)).toBe('notice:turn-failed');
  });

  it('exitDuringAside: the process lost during an aside ends it as lost, before the session is closed', async () => {
    const h = harness = await codexHarness();
    const { s, through } = await started(h);
    h.control({ exitDuringAside: 1 });
    ask(s, 1, childTurn('m20b-fork-followup').question, { throughTurn: through });
    await s.session.closed;
    expect(ofAside(s, 1).at(-1)).toMatchObject({ type: 'turn-ended', outcome: 'failed', reported: false, failure: 'connection-lost' });
    expect(kinds(ofAside(s, 1)).at(-2)).toBe('notice:connection-lost');
  });

  it('starts the session’s process and resumes its thread, with no turn of the session’s, when none is open (C10)', async () => {
    const h = harness = await codexHarness();
    const { s, through } = await started(h);
    await s.session.close();
    const again = resume(h, s.reference() as string);
    ask(again, 1, childTurn('m20b-fork-followup').question, { throughTurn: through });
    expect((await asideEnded(again, 1)).outcome).toBe('completed');
    const { thread } = only(h);
    expect(thread.launches).toHaveLength(2);
    expect(thread.turns).toHaveLength(1);
    // Of its own, the mode its resume confirmed (M22, C2), and nothing of a turn.
    expect(own(again)).toEqual([{ type: 'in-force', mode: 'read-only' }]);
    again.send(PROMPTS.t1, 2);
    expect((await again.ended('turn-2')).outcome).toBe('completed');
    expect(only(h).thread.launches).toHaveLength(2);
  });
});
