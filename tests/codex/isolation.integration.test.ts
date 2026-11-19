// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V9, V28, V46 (docs/planning/_archive/M15.md; C12, C17, C19, C84, C88, C89, C113): what stays inside one
// session — a lost process, a lost frame, an over-long string — on the real adapter and process
// layer against the replay fake. The runtime's side (an unconfirmed end, a removal) is in
// tests/codex/runtime.integration.test.ts.
//
// The history read carries what the conversation store matches by (docs/planning/_archive/M18.md, V16, V17,
// V26; C47, C51, C59): each turn's own id, outcome and times, each message's turn, and whether a
// turn's end was Codex's own.
import { afterEach, describe, expect, it } from 'vitest';
import { AgentEventSchema, HistoryMessageSchema, HistoryTurnSchema, MAX_MESSAGE_TEXT } from '@shared/contracts/agent-events';
import { MAX_LINE_INPUT } from '@shared/contracts/sessions';
import type { CodexSession } from '../../src/main/providers/codex/session';
import { codexHarness, eventually, type Harness, PROMPTS, watch } from './harness';

let harness: Harness | undefined;
afterEach(async () => { await harness?.dispose(); harness = undefined; });
const start = (h: Harness) => watch(h.facet.start({ folder: h.project, model: 'gpt-6-astra', effort: 'low', speed: null, otherFolders: [], mode: 'read-only', processKey: 'process-1' }));
const counts = (session: ReturnType<typeof start>) => (session.session as CodexSession).counts;
const signal = (): AbortSignal => new AbortController().signal;

describe('a lost process (V9; C12, C17, C84)', () => {
  it('ends its own turn as failed, leaves the other session’s turn and the usage reads running, and is never started again', async () => {
    const h = harness = await codexHarness();
    const other = start(h);
    other.send(PROMPTS.t4);
    await other.until((event) => event.type === 'action-changed' && event.kind === 'reading');

    h.control({ exitDuringTurn: 1 });
    const lost = start(h);
    lost.send(PROMPTS.t1);
    expect(await lost.ended('turn-1')).toEqual({ type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: false, failure: 'connection-lost' });
    expect(lost.notices()).toEqual(['connection-lost']);
    await expect(lost.session.closed).resolves.toEqual({ ok: true });
    // Nothing was started in its place: the existing connection's process and the other session's.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(h.running()).toHaveLength(2);
    expect(h.pids()).toHaveLength(3);

    expect(other.types()).not.toContain('turn-ended');
    expect((await h.provider.getUsage(signal())).kind).toBe('usage');
    other.session.stop();
    expect((await other.ended('turn-1')).outcome).toBe('interrupted');
  });

  it('ends the workers left after a turn as failed when the process goes, with its notice', async () => {
    const h = harness = await codexHarness();
    h.control({ exitAfterTurnWithWorker: 1 });
    const session = start(h);
    session.send(PROMPTS.outlive);
    expect((await session.ended('turn-1')).outcome).toBe('completed');
    await session.until((event) => event.type === 'notice' && event.kind === 'workers-lost');
    expect(session.events.filter((event) => event.type === 'worker-ended')).toEqual([expect.objectContaining({ outcome: 'failed' })]);
    await expect(session.session.closed).resolves.toEqual({ ok: true });
  });

  it('lets a worker outlive its turn, and reports its end when it comes', async () => {
    const h = harness = await codexHarness();
    const session = start(h);
    session.send(PROMPTS.outlive);
    expect((await session.ended('turn-1')).outcome).toBe('completed');
    const turnEnd = session.types().indexOf('turn-ended');
    await session.until((event) => event.type === 'worker-ended');
    expect(session.types().indexOf('worker-ended')).toBeGreaterThan(turnEnd);
    expect(session.events.find((event) => event.type === 'worker-ended')).toMatchObject({ outcome: 'completed' });
  });

  it('reports T3’s worker as failed, once, when its own turn failed in the same chunk as its announcement (V43)', async () => {
    const h = harness = await codexHarness();
    h.control({ oneChunk: 1, workerTurnFailed: true });
    const session = start(h);
    session.send(PROMPTS.t3);
    expect((await session.ended('turn-1')).outcome).toBe('completed');
    expect(session.events.filter((event) => event.type === 'worker-ended')).toEqual([expect.objectContaining({ outcome: 'failed' })]);
    // Its first frame, which arrives before its announcement, is the one frame of another thread.
    expect(counts(session).dropped['other-thread']).toBe(1);
    expect(session.events.filter((event) => event.type === 'message' && event.role === 'assistant').length).toBeGreaterThan(0);
  });
});

describe('a lost frame (V28; C19, C88, C89)', () => {
  it('drops oversized tool output and counts it, and the turn goes on to its own end', async () => {
    const h = harness = await codexHarness();
    h.control({ oversize: 'toolOutput' });
    const session = start(h);
    session.send(PROMPTS.t1);
    expect((await session.ended('turn-1')).outcome).toBe('completed');
    expect(counts(session).dropped.oversized).toBe(1);
    expect(session.events.filter((event) => event.type === 'message' && event.phase === 'final')).toHaveLength(1);
    expect(h.services.diagnostics.snapshot()).toContainEqual({ type: 'frame-dropped', reason: 'oversized' });
  });

  it('ends the turn as failed with end-lost when its turn/completed was too large to take', async () => {
    const h = harness = await codexHarness({ timings: { lostEndMs: 250 } });
    h.control({ oversize: 'turnCompleted' });
    const session = start(h);
    session.send(PROMPTS.t1);
    expect(await session.ended('turn-1')).toEqual({ type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: false, failure: 'end-lost' });
    expect(session.notices()).toEqual(['output-lost']);
    // The answer itself had arrived as its own item, and the process is still up.
    expect(session.events.filter((event) => event.type === 'message' && event.phase === 'final')).toHaveLength(1);
    h.control({});
    session.send(PROMPTS.t1, 2);
    expect((await session.ended('turn-2')).outcome).toBe('completed');
  });

  it('runs an oversized reply to its step’s deadline, fails the step, and sends nothing again', async () => {
    // The line must have passed its limit before the step's deadline: the failed start ends the
    // process, and a line still arriving then is never counted. Two seconds is room for a slow
    // machine to take four mebibytes (M21: its sibling in the aside tests met a deadline first in CI).
    const h = harness = await codexHarness({ timings: { openMs: 2_000 } });
    h.control({ oversize: 'reply' });
    const session = start(h);
    session.send(PROMPTS.t1);
    expect((await session.ended('turn-1')).failure).toBe('start-failed');
    expect(session.events.find((event) => event.type === 'notice')).toMatchObject({ kind: 'start-failed', step: 'open' });
    expect(counts(session).dropped.oversized).toBe(1);
    expect(Object.keys(h.threads())).toHaveLength(1);
  });

  it('keeps the existing connection up through an oversized history page: the usage reads go on', async () => {
    const h = harness = await codexHarness();
    const session = start(h);
    session.send(PROMPTS.saved);
    await session.ended('turn-1');
    const reference = session.reference() as string;
    h.control({ oversize: 'historyPage' });
    expect(await h.history.read(reference, { cursor: null, size: 8, detail: 'full' }, signal())).toEqual({ kind: 'dropped' });
    h.control({});
    expect((await h.provider.getUsage(signal())).kind).toBe('usage');
    expect((await h.history.read(reference, { cursor: null, size: 8, detail: 'full' }, signal())).kind).toBe('page');
    // The one process that was there before is the one that is there now.
    expect(h.pids().filter((pid) => h.running().includes(pid))).toContain(h.pids()[0]);
  });

  it('receives image history above the account envelope limit and keeps ordinary usage reads working', async () => {
    const h = harness = await codexHarness();
    const session = start(h);
    session.send(PROMPTS.saved);
    await session.ended('turn-1');
    const data = Buffer.alloc(1_000_000, 1).toString('base64');
    h.control({ generatedImage: data });
    const history = await h.history.read(session.reference() as string, { cursor: null, size: 8, detail: 'full' }, signal());
    expect(history.kind).toBe('page');
    const image = history.kind === 'page' ? history.images?.[0]?.image : undefined;
    expect(image?.kind === 'base64' && image.data.length === data.length).toBe(true);
    h.control({});
    expect((await h.provider.getUsage(signal())).kind).toBe('usage');
  });
});

describe('an over-long string (V46; C113)', () => {
  it('cuts an answer of 100 001 characters to its bound and says so, and still delivers it', async () => {
    const h = harness = await codexHarness();
    h.control({ longText: 'answer' });
    const session = start(h);
    session.send(PROMPTS.t1);
    await session.ended('turn-1');
    const answer = session.events.find((event) => event.type === 'message' && event.phase === 'final');
    expect(answer?.type === 'message' && answer.text.length).toBe(MAX_MESSAGE_TEXT);
    expect(answer?.type === 'message' && answer.cut).toBe(true);
    for (const event of session.events) expect(AgentEventSchema.safeParse(event).success, event.type).toBe(true);
  });

  it('still labels the action with a commentary over 2 000 characters', async () => {
    const h = harness = await codexHarness();
    h.control({ longText: 'commentary' });
    const session = start(h);
    session.send(PROMPTS.t1);
    await session.ended('turn-1');
    const reading = session.events.find((event) => event.type === 'action-changed' && event.kind === 'reading');
    expect(reading?.type === 'action-changed' && reading.line?.length).toBeLessThanOrEqual(MAX_LINE_INPUT);
    expect(reading?.type === 'action-changed' && (reading.line ?? '').length).toBeGreaterThan(20);
    expect(session.events.find((event) => event.type === 'message' && event.phase === 'commentary')).toMatchObject({ phase: 'commentary' });
  });

  it('leaves out a seventeenth question and a ninth option', async () => {
    const h = harness = await codexHarness();
    h.control({ longText: 'question' });
    const session = start(h);
    session.send(PROMPTS.t6);
    const asked = await session.until((event) => event.type === 'message' && event.questions !== undefined);
    expect(asked.type === 'message' && asked.questions).toHaveLength(16);
    expect(asked.type === 'message' && asked.questions?.[0]?.options).toHaveLength(8);
    expect(asked.type === 'message' && asked.cut).toBe(true);
    session.session.stop();
    await session.ended('turn-1');
  });
});

describe('the history read (V30, V53, V60; C57, C102, C120, C134)', () => {
  /** A session with the saved thread's turn, so its history is the captured one. */
  async function withHistory(h: Harness): Promise<{ reference: string; live: string[]; turn: string | undefined }> {
    const session = start(h);
    session.send(PROMPTS.saved);
    await session.ended('turn-1');
    const live = session.events.flatMap((event) => (event.type === 'message' ? [event.itemId] : []));
    // Codex's own id for the turn, as its start gave it (M18, C47).
    const turn = session.events.flatMap((event) => (event.type === 'turn-started' ? [event.providerTurnId] : []))[0];
    return { reference: session.reference() as string, live, turn };
  }

  it('reads both sides of the conversation, oldest first, with the ids the live turn carried, and starts no process', async () => {
    const h = harness = await codexHarness();
    const { reference, live, turn } = await withHistory(h);
    const before = h.pids().length;
    const answer = await h.history.read(reference, { cursor: null, size: 8, detail: 'full' }, signal());
    if (answer.kind !== 'page') throw new Error(answer.kind);
    expect(answer.turns).toHaveLength(2);
    expect(answer.next).toBeNull();
    expect(answer.messages.map((message) => [message.role, message.phase])).toEqual([['user', null], ['assistant', 'commentary'], ['assistant', 'final'], ['user', null], ['assistant', 'commentary'], ['assistant', 'final']]);
    expect(answer.messages.slice(0, 3).map((message) => message.itemId)).toEqual(live);
    expect(answer.messages[0]?.text).toBe(PROMPTS.saved);
    expect(answer.messages[3]?.text).toBe(PROMPTS.resume);
    expect(typeof answer.messages[0]?.at).toBe('number');
    expect(h.pids()).toHaveLength(before);

    // What the conversation store matches by (M18, C47, C51): the turns, oldest first, the first by
    // the id its live start gave; how Codex says each ended, and its times; each message's turn.
    for (const entry of answer.turns) expect(HistoryTurnSchema.safeParse(entry).success, entry.turnId).toBe(true);
    for (const message of answer.messages) expect(HistoryMessageSchema.safeParse(message).success, message.itemId).toBe(true);
    const [saved, resumed] = answer.turns;
    expect(typeof turn).toBe('string');
    expect(saved?.turnId).toBe(turn);
    expect(resumed?.turnId).not.toBe(turn);
    expect(answer.turns.map((entry) => entry.outcome)).toEqual(['completed', 'completed']);
    for (const entry of answer.turns) {
      expect(entry.endedAt).toBeGreaterThan(entry.startedAt ?? Infinity);
      expect(entry.durationMs).toBeGreaterThan(0);
    }
    expect(saved?.startedAt).toBeLessThan(resumed?.startedAt ?? 0);
    expect(answer.messages.map((message) => message.turnId)).toEqual([turn, turn, turn, resumed?.turnId, resumed?.turnId, resumed?.turnId]);
    expect(answer.messages.map((message) => message.at)).toEqual([saved?.startedAt, saved?.startedAt, saved?.startedAt, resumed?.startedAt, resumed?.startedAt, resumed?.startedAt]);
    // A user's message has the id the CLI kept for it; an assistant's has none. That there is one is
    // all the replay shows: it gives a history's client id an id of its own, not the one the live
    // prompt was sent with.
    expect(answer.messages.map((message) => typeof message.clientId)).toEqual(['string', 'undefined', 'undefined', 'string', 'undefined', 'undefined']);
  });

  it('pages newest first, and reads a turn as its summary or not at all', async () => {
    const h = harness = await codexHarness();
    const { reference } = await withHistory(h);
    const newest = await h.history.read(reference, { cursor: null, size: 1, detail: 'full' }, signal());
    if (newest.kind !== 'page') throw new Error(newest.kind);
    expect(newest.turns).toHaveLength(1);
    expect(newest.messages[0]?.text).toBe(PROMPTS.resume);
    expect(typeof newest.next).toBe('string');
    const older = await h.history.read(reference, { cursor: newest.next, size: 8, detail: 'full' }, signal());
    expect(older.kind === 'page' && older.messages[0]?.text).toBe(PROMPTS.saved);
    expect(older.kind === 'page' && older.next).toBeNull();

    const summary = await h.history.read(reference, { cursor: null, size: 1, detail: 'summary' }, signal());
    expect(summary.kind === 'page' && summary.messages.map((message) => [message.role, message.phase])).toEqual([['user', null], ['assistant', 'final']]);
    const none = await h.history.read(reference, { cursor: null, size: 1, detail: 'none' }, signal());
    // Turns and no message (M18, C51): the same turn, by its id.
    expect(none).toMatchObject({ kind: 'page', messages: [] });
    expect(none.kind === 'page' && none.turns.map((turn) => turn.turnId)).toEqual(newest.turns.map((turn) => turn.turnId));
    expect(none.kind === 'page' && none.next).toBe(newest.next);
  });

  it('answers `dropped` at once for a page that was too large, and `failed` for one that is only slow (C120)', async () => {
    const h = harness = await codexHarness();
    const { reference } = await withHistory(h);
    h.control({ oversize: 'historyTurn' });
    const started = Date.now();
    expect(await h.history.read(reference, { cursor: null, size: 8, detail: 'full' }, signal())).toEqual({ kind: 'dropped' });
    // At the drop, not at the request's 2-second deadline.
    expect(Date.now() - started).toBeLessThan(1500);
    expect((await h.history.read(reference, { cursor: null, size: 1, detail: 'summary' }, signal())).kind).toBe('page');

    h.control({ hang: 'history' });
    expect(await h.history.read(reference, { cursor: null, size: 8, detail: 'full' }, signal())).toEqual({ kind: 'failed' });
    h.control({});
    expect((await h.history.read(reference, { cursor: null, size: 8, detail: 'full' }, signal())).kind).toBe('page');
  });

  it('fails, and starts nothing, for a thread that is gone, a read that is cancelled, and a connection that is not up', async () => {
    const h = harness = await codexHarness();
    expect(await h.history.read('11111111-1111-4111-8111-111111111111', { cursor: null, size: 8, detail: 'full' }, signal())).toEqual({ kind: 'failed' });
    const cancelled = new AbortController();
    cancelled.abort();
    expect(await h.history.read('x', { cursor: null, size: 8, detail: 'full' }, cancelled.signal)).toEqual({ kind: 'failed' });
    const cold = await codexHarness({ connect: false });
    try {
      expect(await cold.history.read('x', { cursor: null, size: 8, detail: 'full' }, signal())).toEqual({ kind: 'failed' });
      expect(cold.pids()).toEqual([]);
    } finally { await cold.dispose(); }
  });

  it('cuts an over-long history item to its bound, and says so', async () => {
    const h = harness = await codexHarness();
    const { reference } = await withHistory(h);
    h.control({ longText: 'historyItem' });
    const answer = await h.history.read(reference, { cursor: null, size: 8, detail: 'full' }, signal());
    const answers = answer.kind === 'page' ? answer.messages.filter((message) => message.phase === 'final') : [];
    expect(answers.map((message) => [message.text.length, message.cut])).toEqual([[MAX_MESSAGE_TEXT, true], [MAX_MESSAGE_TEXT, true]]);
  });

  it('says that history can be read again when the existing connection comes back', async () => {
    const h = harness = await codexHarness({ connect: false });
    let told = 0;
    h.history.onAvailable(() => { told += 1; });
    await h.provider.getAccount(signal());
    await eventually(() => told > 0, 5000, 'the facet’s word');
  });
});
