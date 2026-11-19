// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V3, V14 (docs/planning/_archive/M20b.md; C10, C12–C18, C62, C70): a question asked beside a Claude session,
// on the real adapter and process layer against the replay fake. The side questions are K1's, each
// answered from its capture; a fault is that capture's frame with one named change. No test here
// uses the real CLI.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type AgentEvent, AgentEventSchema } from '@shared/contracts/agent-events';
import type { AsideExchange, AsideRequest } from '@shared/provider-kit/sessions';
import type { ClaudeChatSession } from '../../../src/main/providers/claude/chat-session';
import { claudeHarness, eventually, type Harness, type HarnessOptions, processGone, promptOf, READING, watch, type Watched } from './harness';

let harness: Harness | undefined;
afterEach(async () => { await harness?.dispose(); harness = undefined; });
const open = async (options?: HarnessOptions): Promise<Harness> => (harness = await claudeHarness(options));
const start = (h: Harness) => watch(h.facet.start({ folder: h.project, model: 'sonnet', effort: 'low', speed: null, otherFolders: [], ...READING }));
const resume = (h: Harness, reference: string) => watch(h.facet.resume({ folder: h.project, model: 'sonnet', effort: 'low', speed: null, otherFolders: [], ...READING, reference }));
const counts = (s: Watched) => (s.session as ClaudeChatSession).counts;

interface Captured { readonly dir: string; readonly frame: { type?: string; request_id?: string; request?: { subtype?: string; question?: string; history?: AsideExchange[] }; response?: { request_id?: string; subtype?: string; response?: { response?: string } } } }
const frames = (name: string): Captured[] => (JSON.parse(readFileSync(path.resolve('tests/fixtures/claude/captures', `${name}.json`), 'utf8')) as { frames: Captured[] }).frames;
/** A capture's side question: its words, the history it was sent with, and the answer it got. */
function side(name: string, nth = 0): { readonly question: string; readonly history: readonly AsideExchange[]; readonly answer: string | null } {
  const all = frames(name);
  const sent = all.filter((entry) => entry.dir === 'send' && entry.frame.request?.subtype === 'side_question')[nth];
  if (sent === undefined || typeof sent.frame.request?.question !== 'string') throw new Error(`${name} has no side question ${nth}`);
  const reply = all.find((entry) => entry.dir === 'recv' && entry.frame.type === 'control_response' && entry.frame.response?.request_id === sent.frame.request_id && entry.frame.response?.subtype === 'success');
  return { question: sent.frame.request.question, history: sent.frame.request.history ?? [], answer: reply?.frame.response?.response?.response ?? null };
}

const ASIDE = (n: number): string => `a51de000-0000-4000-8000-00000000000${n}`;
const TURN = (n: number): string => `aside-turn-${n}`;
/** Asks aside `n` a question, as main does: with ids of its own, and the aside's earlier exchanges. */
function ask(s: Watched, n: number, text: string, history: readonly AsideExchange[] = []): AsideRequest {
  const request: AsideRequest = { asideId: ASIDE(n), turnId: TURN(n), text, messageId: `00000000-0000-4000-8000-0000000000a${n}`, history, throughTurn: null, effort: 'low', speed: null };
  s.session.ask?.(request);
  return request;
}
const ofAside = (s: Watched, n: number): AgentEvent[] => s.events.filter((event) => 'asideId' in event && event.asideId === ASIDE(n));
const kinds = (events: readonly AgentEvent[]): string[] => events.map((event) => (event.type === 'notice' ? `notice:${event.kind}` : event.type));
const asideEnded = (s: Watched, n: number) => s.ended(TURN(n));
/** A session that has held a turn: what the runtime requires before it takes an ask (C10). */
async function started(h: Harness): Promise<Watched> {
  const s = start(h);
  s.send(h.prompts.t1);
  await s.ended('turn-1');
  return s;
}

describe('a side question (V3; C13, C14, C17)', () => {
  it('is answered whole, as one message under the aside’s own turn: started by the progress frame, ended by the CLI’s own reply', async () => {
    const h = await open();
    const s = await started(h);
    const idle = side('m20b-idle');
    const before = s.events.length;
    ask(s, 1, idle.question);
    expect(await asideEnded(s, 1)).toEqual({ type: 'turn-ended', turnId: TURN(1), asideId: ASIDE(1), outcome: 'completed', reported: true });
    const events = s.events.slice(before);
    // Every event of it names the aside, and passes the schema; nothing else was said meanwhile.
    expect(events).toEqual(ofAside(s, 1));
    for (const event of events) expect(AgentEventSchema.safeParse(event).success).toBe(true);
    expect(kinds(events)).toEqual(['turn-started', 'message', 'turn-ended']);
    expect(events[0]).toMatchObject({ type: 'turn-started', turnId: TURN(1), asideId: ASIDE(1) });
    expect(events[1]).toMatchObject({ type: 'message', role: 'assistant', phase: 'final', turnId: TURN(1), text: idle.answer });
    expect(events[1]).not.toHaveProperty('model');
    // One request, with no history: on the session's own process, which took no second launch.
    const { entry } = h.only();
    expect((entry as unknown as { sides: unknown[] }).sides).toEqual([{ question: idle.question, history: null, turn: false }]);
    expect(entry.launches).toHaveLength(1);
    expect(entry.turns).toHaveLength(1);
    expect(h.markers()).toEqual([]);
  });

  it('sends the aside’s earlier exchanges with a follow-up, in order, as the capture shows them', async () => {
    const h = await open();
    const s = await started(h);
    const followup = side('m20b-followup');
    expect(followup.history).toHaveLength(1);
    ask(s, 1, followup.question, followup.history);
    expect((await asideEnded(s, 1)).outcome).toBe('completed');
    expect((h.only().entry as unknown as { sides: { history: unknown }[] }).sides[0]?.history).toEqual(followup.history);
    expect(ofAside(s, 1).find((event) => event.type === 'message')).toMatchObject({ text: followup.answer });
  });

  it('is taken while a turn runs, and two at once: each by its own request, and the turn’s own events are as they would be', async () => {
    const h = await open();
    const s = start(h);
    const during = side('m20b-during');
    const [first, second] = [side('m20b-two', 0), side('m20b-two', 1)];
    s.send(promptOf('m20b-during', h.project));
    await s.until((event) => event.type === 'turn-started' && !('asideId' in event && event.asideId !== undefined));
    ask(s, 1, during.question);
    ask(s, 2, first.question);
    ask(s, 3, second.question);
    const ends = await Promise.all([asideEnded(s, 1), asideEnded(s, 2), asideEnded(s, 3)]);
    expect(ends.map((end) => end.outcome)).toEqual(['completed', 'completed', 'completed']);
    const end = await s.ended('turn-1');
    expect(end).toMatchObject({ outcome: 'completed', reported: true });
    // Each aside got its own answer.
    for (const [n, asked] of [[1, during], [2, first], [3, second]] as const) expect(ofAside(s, n).find((event) => event.type === 'message')).toMatchObject({ text: asked.answer });
    // The turn's events name no aside, and its answer is its own: the side questions' frames never reached the mapper (C17).
    const own = s.events.filter((event) => !('asideId' in event && event.asideId !== undefined));
    expect(own.filter((event) => event.type === 'turn-ended')).toHaveLength(1);
    const answer = own.findLast((event) => event.type === 'message' && event.role === 'assistant');
    expect(end).toMatchObject({ answerItemId: answer?.type === 'message' ? answer.itemId : undefined });
    expect(counts(s).dropped['other-turn']).toBe(0);
    expect((h.only().entry as unknown as { sides: { turn: boolean }[] }).sides.map((sent) => sent.turn)).toEqual([true, true, true]);
  });

  it('starts the session’s process, resumed, with no turn of the session’s, when none is open (C10)', async () => {
    const h = await open();
    const first = await started(h);
    const reference = first.reference();
    expect(reference).toBeDefined();
    await first.session.close();
    const s = resume(h, reference as string);
    const idle = side('m20b-idle');
    ask(s, 1, idle.question);
    expect((await asideEnded(s, 1)).outcome).toBe('completed');
    const { entry } = h.only();
    expect(entry.launches).toHaveLength(2);
    expect(entry.launches[1]).toMatchObject({ resume: reference });
    // No prompt was written to it, and no turn of the session's was said.
    expect(entry.turns).toHaveLength(1);
    expect(s.events).toEqual(ofAside(s, 1));
    // The same process then takes the session's next prompt.
    s.send(h.prompts.t1, 2);
    expect((await s.ended('turn-2')).outcome).toBe('completed');
    expect(h.only().entry.launches).toHaveLength(2);
  });
});

describe('an aside’s Stop (V3; C12, C15, C70)', () => {
  it('takes the request back: the CLI’s error reply ends the aside interrupted, and the process takes the next prompt', async () => {
    const h = await open();
    const s = await started(h);
    // K1's cancelled question: its capture shows no answer, so the fake waits for the cancel.
    ask(s, 1, side('m20b-cancel').question);
    await s.until((event) => event.type === 'turn-started' && 'asideId' in event && event.asideId === ASIDE(1));
    s.session.stopAside?.(ASIDE(1));
    expect(await asideEnded(s, 1)).toEqual({ type: 'turn-ended', turnId: TURN(1), asideId: ASIDE(1), outcome: 'interrupted', reported: true });
    expect(kinds(ofAside(s, 1))).toEqual(['turn-started', 'turn-ended']);
    expect((h.only().entry as unknown as { cancels: unknown[] }).cancels).toEqual([{ waiting: true }]);
    // No interrupt was sent: the session's own Stop is another thing.
    expect(h.only().entry.interrupts).toEqual([]);
    s.send(h.prompts.t1, 2);
    expect((await s.ended('turn-2')).outcome).toBe('completed');
    expect(h.only().entry.launches).toHaveLength(1);
  });

  it('ends the aside alone when the cancel is not answered, with its notice, and drops the reply that comes after', async () => {
    const h = await open({ timings: { stopMs: 60 } });
    const s = await started(h);
    h.control({ hang: 'cancel', holdSide: 400 });
    ask(s, 1, side('m20b-idle').question);
    await s.until((event) => event.type === 'turn-started' && 'asideId' in event && event.asideId === ASIDE(1));
    const unread = counts(s).unread;
    s.session.stopAside?.(ASIDE(1));
    expect(await asideEnded(s, 1)).toEqual({ type: 'turn-ended', turnId: TURN(1), asideId: ASIDE(1), outcome: 'interrupted', reported: false });
    expect(kinds(ofAside(s, 1))).toEqual(['turn-started', 'notice:stop-unconfirmed', 'turn-ended']);
    // The answer still comes, to no one: counted, and never shown.
    await eventually(() => counts(s).unread > unread, 10_000, 'the late reply being counted');
    expect(ofAside(s, 1).some((event) => event.type === 'message')).toBe(false);
    // The process was never ended for it (C70).
    expect(h.running('chat')).toHaveLength(1);
    h.control({});
    s.send(h.prompts.t1, 2);
    expect((await s.ended('turn-2')).outcome).toBe('completed');
  });

  it('sends nothing for one stopped while the process was starting', async () => {
    const h = await open();
    const first = await started(h);
    const reference = first.reference() as string;
    await first.session.close();
    h.control({ hang: 'initialize' });
    const s = resume(h, reference);
    ask(s, 1, side('m20b-idle').question);
    await eventually(() => h.pids('chat').length === 2, 10_000, 'the process starting');
    s.session.stopAside?.(ASIDE(1));
    // It ends once the launch it waits for is over: here, when the session is closed.
    await s.session.close();
    expect(await asideEnded(s, 1)).toMatchObject({ outcome: 'interrupted', reported: false });
    expect((h.only().entry as unknown as { sides: unknown[] }).sides).toEqual([]);
  });
});

describe('what an aside’s reply can be (V3, V14; C13, C16, C62)', () => {
  it.each([['null'], ['synthetic']])('sideReply %s: no answer is shown, and the aside’s turn fails with its own notice', async (fault) => {
    const h = await open();
    const s = await started(h);
    h.control({ sideReply: fault });
    ask(s, 1, side('m20b-idle').question);
    expect(await asideEnded(s, 1)).toEqual({ type: 'turn-ended', turnId: TURN(1), asideId: ASIDE(1), outcome: 'failed', reported: true, failure: 'turn-failed' });
    expect(kinds(ofAside(s, 1))).toEqual(['turn-started', 'notice:no-answer', 'turn-ended']);
  });

  it('sideReply fallback: the message names the model that answered', async () => {
    const h = await open();
    const s = await started(h);
    h.control({ sideReply: 'fallback' });
    const idle = side('m20b-idle');
    ask(s, 1, idle.question);
    expect((await asideEnded(s, 1)).outcome).toBe('completed');
    expect(ofAside(s, 1).find((event) => event.type === 'message')).toMatchObject({ text: idle.answer, model: 'claude-haiku-5' });
  });

  it('sideRefused: the CLI’s refusal ends the aside as failed, and the session is untouched', async () => {
    const h = await open();
    const s = await started(h);
    h.control({ sideRefused: 1 });
    ask(s, 1, side('m20b-idle').question);
    expect(await asideEnded(s, 1)).toMatchObject({ outcome: 'failed', reported: true, failure: 'turn-failed' });
    expect(kinds(ofAside(s, 1))).toEqual(['notice:turn-failed', 'turn-ended']);
    ask(s, 2, side('m20b-idle').question);
    expect((await asideEnded(s, 2)).outcome).toBe('completed');
  });

  it('strayProgress: a progress frame for no request is counted, and changes nothing', async () => {
    const h = await open();
    const s = await started(h);
    h.control({ strayProgress: 1 });
    const unread = counts(s).unread;
    ask(s, 1, side('m20b-idle').question);
    expect((await asideEnded(s, 1)).outcome).toBe('completed');
    expect(kinds(ofAside(s, 1))).toEqual(['turn-started', 'message', 'turn-ended']);
    expect(counts(s).unread).toBeGreaterThan(unread);
  });

  it('fails the aside’s turn at its deadline, and leaves the process as it is (C16)', async () => {
    const h = await open({ timings: { asideMs: 80 } });
    const s = await started(h);
    h.control({ hang: 'side' });
    ask(s, 1, side('m20b-idle').question);
    expect(await asideEnded(s, 1)).toEqual({ type: 'turn-ended', turnId: TURN(1), asideId: ASIDE(1), outcome: 'failed', reported: false, failure: 'end-lost' });
    expect(kinds(ofAside(s, 1))).toEqual(['turn-started', 'notice:connection-lost', 'turn-ended']);
    expect(h.running('chat')).toHaveLength(1);
    h.control({});
    s.send(h.prompts.t1, 2);
    expect((await s.ended('turn-2')).outcome).toBe('completed');
    expect(h.only().entry.launches).toHaveLength(1);
  });
});

describe('an aside when its session’s process ends (V3; C34, C70)', () => {
  it('ends as lost when the process is gone, before the session says it is closed', async () => {
    const h = await open();
    const s = await started(h);
    h.control({ hang: 'side' });
    ask(s, 1, side('m20b-idle').question);
    await s.until((event) => event.type === 'turn-started' && 'asideId' in event && event.asideId === ASIDE(1));
    const [pid] = h.running('chat');
    process.kill(pid as number);
    await processGone(h, s.session);
    expect(kinds(ofAside(s, 1))).toEqual(['turn-started', 'notice:connection-lost', 'turn-ended']);
    expect(ofAside(s, 1).at(-1)).toMatchObject({ outcome: 'failed', reported: false, failure: 'connection-lost' });
  });

  it('ends as interrupted when the session is closed, and when the session’s own unconfirmed Stop ends the process, as lost', async () => {
    const h = await open({ timings: { stopMs: 60 } });
    const s = await started(h);
    h.control({ hang: 'side' });
    ask(s, 1, side('m20b-idle').question);
    await s.until((event) => event.type === 'turn-started' && 'asideId' in event && event.asideId === ASIDE(1));
    await s.session.close();
    expect(ofAside(s, 1).at(-1)).toMatchObject({ type: 'turn-ended', outcome: 'interrupted', reported: false });

    // The session's own Stop, unconfirmed, ends its process (decision 0020, item 12): the aside goes with it.
    h.control({ hang: 'stop' });
    const t = resume(h, s.reference() as string);
    t.send(h.prompts.t4, 2);
    await t.until((event) => event.type === 'message-delta' && event.text !== '');
    h.control({ hang: 'stop', holdSide: 60_000 });
    ask(t, 2, side('m20b-idle').question);
    await t.until((event) => event.type === 'turn-started' && 'asideId' in event && event.asideId === ASIDE(2));
    t.session.stop();
    expect(await t.ended('turn-2')).toMatchObject({ outcome: 'interrupted', reported: false });
    await processGone(h, t.session);
    expect(ofAside(t, 2).at(-1)).toMatchObject({ type: 'turn-ended', outcome: 'failed', reported: false, failure: 'connection-lost' });
    // The session's Stop sent no cancel for the aside (C12).
    expect((h.only().entry as unknown as { cancels: unknown[] }).cancels).toEqual([]);
  });
});
