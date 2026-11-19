// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V3, V7, V19, V26 (docs/planning/_archive/M19.md; C7, C8, C14, C18, C19, C54, C56, C64): an answer as it is
// written, on the real Codex adapter and process layer against the replay fake, which sends K1's
// captured deltas to the session handshake — first as the adapter tells it, then through the app's
// own runtime, chat service and conversation store. Each fault is a captured frame with one named
// change (tests/fixtures/codex/replay.mjs).
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentEventSchema, MAX_MESSAGE_TEXT } from '@shared/contracts/agent-events';
import type { ChatPush } from '@shared/contracts/chat';
import { itemText } from '@shared/contracts/conversation';
import type { CodexSession } from '../../src/main/providers/codex/session';
import { type App, launchApp, placeRecords, S, sessionEntry } from '../sessions/app';
import { foldDeltas } from '../sessions/facet-contract';
import { codexHarness, eventually, type Harness, PROMPTS, STREAMED, watch } from './harness';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

let harness: Harness | undefined;
let apps: App[] = [];
afterEach(async () => {
  for (const app of apps) await app.quit();
  apps = [];
  await harness?.dispose();
  harness = undefined;
  for (const spy of Object.values(log)) spy.mockClear();
});

const start = (h: Harness) => watch(h.facet.start({ folder: h.project, model: 'gpt-6-astra', effort: 'low', speed: null, otherFolders: [], mode: 'read-only', processKey: 'process-1' }));
const counts = (session: ReturnType<typeof start>) => (session.session as CodexSession).counts;
/** The item id of the turn's answer: the message its `item/started` opened as `final`. */
const answerId = (session: ReturnType<typeof start>): string => {
  const opened = session.events.find((event) => event.type === 'message-delta' && event.phase === 'final');
  if (opened?.type !== 'message-delta') throw new Error('no answer was opened');
  return opened.itemId;
};

describe('an answer as the adapter tells it (V3, V19; C7, C8, C54)', () => {
  it('opens, grows and completes each message of T1’s prompt, and what the deltas brought is the whole text', async () => {
    const h = harness = await codexHarness();
    const session = start(h);
    session.send(PROMPTS.t1);
    expect((await session.ended('turn-1')).outcome).toBe('completed');
    expect(Object.values(h.threads())[0]?.turns).toEqual([STREAMED.t1]);

    const folded = foldDeltas(session.events);
    expect(folded.faults).toEqual([]);
    expect(folded.open).toEqual([]);
    const said = folded.events.flatMap((event) => (event.type === 'message' && event.role === 'assistant' ? [event] : []));
    expect(said.map((event) => event.phase)).toEqual(['commentary', 'final']);
    for (const message of said) expect(folded.streamed.get(message.itemId)).toBe(message.text);
    expect(said[1]?.text).toContain('Biscuit');
    // 12 and 7 deltas, and an opening each (K1).
    expect(session.events.filter((event) => event.type === 'message-delta')).toHaveLength(12 + 7 + 2);
    for (const event of session.events) expect(AgentEventSchema.safeParse(event).success, event.type).toBe(true);
    expect(counts(session).dropped).toMatchObject({ 'other-thread': 0, 'other-turn': 0, 'unopened-item': 0, 'completed-item': 0, invalid: 0 });
  });

  it('streams a long Markdown answer whole: its 840 deltas, a code block and a table', async () => {
    const h = harness = await codexHarness();
    const session = start(h);
    session.send(PROMPTS.markdown);
    expect((await session.ended('turn-1', 30_000)).outcome).toBe('completed');
    const folded = foldDeltas(session.events);
    const [answer] = folded.events.flatMap((event) => (event.type === 'message' && event.role === 'assistant' ? [event] : []));
    expect(session.events.filter((event) => event.type === 'message-delta' && event.text !== '')).toHaveLength(840);
    expect(folded.streamed.get(answer?.itemId ?? '')).toBe(answer?.text);
    expect(answer?.text).toContain('```');
    expect(answer?.text).toMatch(/\|.*\|/);
  });

  it('streams a worker’s messages under the worker’s id, apart from the session’s own (T3’s prompt; M20a, C20)', async () => {
    const h = harness = await codexHarness();
    const session = start(h);
    session.send(PROMPTS.t3);
    expect((await session.ended('turn-1', 30_000)).outcome).toBe('completed');
    expect(Object.values(h.threads())[0]?.turns).toEqual([STREAMED.t3]);
    const folded = foldDeltas(session.events);
    const messages = folded.events.flatMap((event) => (event.type === 'message' && event.role === 'assistant' ? [event] : []));
    // The session's own: its commentary and its answer.
    expect(messages.filter((event) => event.workerId === undefined)).toHaveLength(2);
    // What its worker said is the worker's: the message names it, and so does each delta of it.
    const [worker] = session.events.flatMap((event) => (event.type === 'worker-started' ? [event.workerId] : []));
    const theirs = messages.filter((event) => event.workerId !== undefined);
    expect(theirs).toHaveLength(1);
    expect(theirs[0]?.workerId).toBe(worker);
    const owners = new Map<string, Set<string | undefined>>();
    for (const event of session.events) if (event.type === 'message-delta') owners.set(event.itemId, (owners.get(event.itemId) ?? new Set()).add(event.workerId));
    for (const message of messages) expect([...(owners.get(message.itemId) ?? [])]).toEqual([message.workerId]);
    // Each streamed whole, under its own id.
    expect([...folded.streamed.keys()].sort()).toEqual(messages.map((event) => event.itemId).sort());
    for (const message of messages) expect(folded.streamed.get(message.itemId)).toBe(message.text);
    expect(session.types()).toEqual(expect.arrayContaining(['worker-started', 'worker-ended']));
    expect(counts(session).dropped).toMatchObject({ 'unopened-item': 0, 'completed-item': 0 });
  });

  it('leaves an interrupted answer open: Codex sends no whole message for it, and the turn ends interrupted', async () => {
    const h = harness = await codexHarness();
    const session = start(h);
    session.send(PROMPTS.interrupted);
    // The capture shows the interrupt after five deltas: the fake waits there for it.
    await session.until((event) => event.type === 'message-delta' && event.text !== '');
    await eventually(() => session.events.filter((event) => event.type === 'message-delta' && event.text !== '').length === 5, 10_000, 'the five deltas');
    session.session.stop();
    expect(await session.ended('turn-1')).toMatchObject({ outcome: 'interrupted', reported: true });
    const folded = foldDeltas(session.events);
    expect(folded.open).toHaveLength(1);
    expect(folded.streamed.get(folded.open[0] ?? '')?.length).toBeGreaterThan(0);
    expect(folded.events.some((event) => event.type === 'message' && event.role === 'assistant')).toBe(false);
  });
});

describe('each fault, one named change (V19; C56)', () => {
  it('wholeDiffers: the whole message carries another text than its deltas brought', async () => {
    const h = harness = await codexHarness();
    h.control({ wholeDiffers: true });
    const session = start(h);
    session.send(PROMPTS.t1);
    await session.ended('turn-1');
    const folded = foldDeltas(session.events);
    const answer = folded.events.find((event) => event.type === 'message' && event.phase === 'final');
    if (answer?.type !== 'message') throw new Error('no answer');
    expect(answer.text).toBe(`${folded.streamed.get(answer.itemId)} (as completed)`);
    // The commentary is as it was.
    const commentary = folded.events.find((event) => event.type === 'message' && event.phase === 'commentary');
    expect(commentary?.type === 'message' && folded.streamed.get(commentary.itemId)).toBe(commentary?.type === 'message' ? commentary.text : null);
  });

  it('noCompletion: the answer’s completing frame is withheld, and the turn still ends completed', async () => {
    const h = harness = await codexHarness();
    h.control({ noCompletion: true });
    const session = start(h);
    session.send(PROMPTS.t1);
    expect(await session.ended('turn-1')).toMatchObject({ outcome: 'completed', reported: true });
    const folded = foldDeltas(session.events);
    expect(folded.open).toEqual([answerId(session)]);
    expect(folded.streamed.get(answerId(session))).toContain('Biscuit');
    expect(folded.events.filter((event) => event.type === 'message' && event.role === 'assistant').map((event) => (event.type === 'message' ? event.phase : null))).toEqual(['commentary']);
  });

  it('noDeltas: the answer’s deltas are withheld, so it arrives whole', async () => {
    const h = harness = await codexHarness();
    h.control({ noDeltas: true });
    const session = start(h);
    session.send(PROMPTS.t1);
    await session.ended('turn-1');
    const id = answerId(session);
    expect(session.events.filter((event) => event.type === 'message-delta' && event.itemId === id).map((event) => (event.type === 'message-delta' ? event.text : null))).toEqual(['']);
    expect(session.events.find((event) => event.type === 'message' && event.itemId === id)).toMatchObject({ phase: 'final' });
    // The commentary's still came.
    expect(session.events.filter((event) => event.type === 'message-delta' && event.itemId !== id && event.text !== '')).toHaveLength(12);
  });

  it.each([
    ['deltaOtherThread', 'other-thread'],
    ['deltaOtherTurn', 'other-turn'],
  ] as const)('%s: every delta is dropped and counted, and the whole messages arrive', async (control, reason) => {
    const h = harness = await codexHarness();
    h.control({ [control]: true });
    const session = start(h);
    session.send(PROMPTS.t1);
    await session.ended('turn-1');
    expect(session.events.filter((event) => event.type === 'message-delta' && event.text !== '')).toEqual([]);
    expect(counts(session).dropped[reason]).toBe(19);
    expect(session.events.filter((event) => event.type === 'message' && event.role === 'assistant')).toHaveLength(2);
  });

  it('deltaAfterComplete: the answer’s last delta, sent again after its completing frame, is dropped and counted', async () => {
    const h = harness = await codexHarness();
    h.control({ deltaAfterComplete: true });
    const session = start(h);
    session.send(PROMPTS.t1);
    await session.ended('turn-1');
    expect(counts(session).dropped['completed-item']).toBe(1);
    expect(foldDeltas(session.events).faults).toEqual([]);
  });

  it('deltasPastBound: each delta is 20 000 units, so the answer’s pass a message’s bound', async () => {
    const h = harness = await codexHarness();
    h.control({ deltasPastBound: true });
    const session = start(h);
    session.send(PROMPTS.t1);
    await session.ended('turn-1');
    const id = answerId(session);
    const sizes = session.events.flatMap((event) => (event.type === 'message-delta' && event.itemId === id && event.text !== '' ? [event.text.length] : []));
    expect(sizes).toEqual(Array.from({ length: 7 }, () => 20_000));
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeGreaterThan(MAX_MESSAGE_TEXT);
    // The whole message is as the capture has it.
    expect(session.events.find((event) => event.type === 'message' && event.itemId === id)).toMatchObject({ phase: 'final' });
  });

  it('exitBetweenDeltas: the process ends after the answer’s second delta, and the turn ends with it', async () => {
    const h = harness = await codexHarness();
    h.control({ exitBetweenDeltas: 1 });
    const session = start(h);
    session.send(PROMPTS.t1);
    expect(await session.ended('turn-1')).toMatchObject({ outcome: 'failed', reported: false, failure: 'connection-lost' });
    const id = answerId(session);
    expect(session.events.filter((event) => event.type === 'message-delta' && event.itemId === id && event.text !== '')).toHaveLength(2);
    expect(foldDeltas(session.events).open).toEqual([id]);
    await expect(session.session.closed).resolves.toEqual({ ok: true });
  });
});

// ── Through the app: the runtime, the chat service and a conversation store on disk ───────────
const dataDir = (h: Harness) => path.join(h.dir, 'records');
function launch(h: Harness): App {
  const app = launchApp({ dir: dataDir(h), descriptor: h.provider.descriptor, facet: () => h.facet, log, userDefault: () => 'ask-first' });
  apps.push(app);
  return app;
}
async function quit(app: App): Promise<void> {
  apps = apps.filter((candidate) => candidate !== app);
  await app.quit();
}
const place = (h: Harness): void => placeRecords(dataDir(h), h.project, 'codex', [sessionEntry(1, 'codex', { model: 'gpt-6-astra' })]);
const idle = (app: App) => eventually(() => !app.service.isRunning(S(1)), 20_000, 'the session coming to rest');
const kinds = (pushes: readonly ChatPush[]) => pushes.map((push) => ('item' in push ? `item:${push.item.role}:${push.item.state}` : 'partial' in push ? 'partial' : 'changed'));
const answerOf = (app: App) => app.read(1).items.findLast((item) => item.role === 'assistant');

describe('an answer through the app (V7, V20, V26; C14, C18, C19, C64)', () => {
  it('shows each message from its opening, streaming, then complete under the same id, and keeps it whole in the store', async () => {
    const h = harness = await codexHarness();
    place(h);
    const app = launch(h);
    expect(await app.runtime.send(S(1), PROMPTS.t1)).toEqual({ status: 'accepted' });
    await idle(app);
    const said = kinds(app.pushes).filter((kind) => kind.startsWith('item:assistant'));
    expect(said).toEqual(['item:assistant:streaming', 'item:assistant:complete', 'item:assistant:streaming', 'item:assistant:complete']);
    const opened = app.pushes.flatMap((push) => ('item' in push && push.item.role === 'assistant' ? [`${push.item.id}:${push.item.state}`] : []));
    expect(opened[0]?.split(':')[0]).toBe(opened[1]?.split(':')[0]);
    expect(opened[2]?.split(':')[0]).toBe(opened[3]?.split(':')[0]);
    // Between the two, what it did (M20a, C29): an activity of the turn, ended.
    expect(app.read(1).items.map((item) => (item.kind === 'activity' ? `activity:${item.activity?.status}:${item.state}` : `${item.role}:${item.phase}:${item.state}`))).toEqual(['user:null:complete', 'assistant:commentary:complete', 'activity:completed:complete', 'assistant:final:complete']);
    expect(itemText(answerOf(app) ?? { blocks: [] })).toContain('Biscuit');
    // No text of it in a log, and none in the summary (C23).
    expect(JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls])).not.toContain('Biscuit');
    expect(JSON.stringify(app.service.snapshot())).not.toContain('Biscuit');
    expect(app.chat.dropped()).toEqual({ bound: 0, 'turn-ended': 0, complete: 0, unopened: 0 });
  });

  it('takes the whole message’s text where the deltas brought another (wholeDiffers)', async () => {
    const h = harness = await codexHarness();
    place(h);
    h.control({ wholeDiffers: true });
    const app = launch(h);
    await app.runtime.send(S(1), PROMPTS.t1);
    await idle(app);
    expect(itemText(answerOf(app) ?? { blocks: [] })).toMatch(/ \(as completed\)$/);
    expect(answerOf(app)).toMatchObject({ state: 'complete' });
  });

  it('leaves an answer partial under a finished, gapless turn when its completing frame never comes (noCompletion)', async () => {
    const h = harness = await codexHarness();
    place(h);
    h.control({ noCompletion: true });
    const app = launch(h);
    await app.runtime.send(S(1), PROMPTS.t1);
    await idle(app);
    const read = app.read(1);
    expect(answerOf(app)).toMatchObject({ state: 'partial', phase: 'final' });
    expect(itemText(answerOf(app) ?? { blocks: [] })).toContain('Biscuit');
    expect(read.turns[0]).toMatchObject({ state: 'ended', outcome: 'completed', gap: false });
    expect(read.storage).toBe('ok');
    // After a restart it reads the same: partial, and never streaming.
    await quit(app);
    const again = launch(h);
    expect(answerOf(again)).toMatchObject({ state: 'partial', phase: 'final' });
    expect(again.read(1).turns[0]).toMatchObject({ state: 'ended' });
  });

  it('says a message was cut while it still streams, and keeps it partial and cut through a Stop and a restart (deltasPastBound, no completing frame)', async () => {
    const h = harness = await codexHarness();
    place(h);
    h.control({ deltasPastBound: true, noCompletion: true, turnNeverEnds: true });
    const app = launch(h);
    await app.runtime.send(S(1), PROMPTS.t1);
    // The item pushed at the bound: cut, with the text to the bound, and still streaming.
    const atBound = await eventually(() => app.pushes.find((push) => 'item' in push && push.item.blocks[0]?.cut === true), 20_000, 'the push at the bound');
    if (!('item' in atBound)) throw new Error('not an item push');
    expect(atBound.item).toMatchObject({ state: 'streaming', phase: 'final' });
    expect(itemText(atBound.item)).toHaveLength(MAX_MESSAGE_TEXT);
    expect(app.chat.dropped().bound).toBeGreaterThan(0);
    expect(answerOf(app)).toMatchObject({ state: 'streaming', blocks: [{ cut: true }] });

    // A Stop: the turn ends, and the message is left as it is. The faults stay in force until it has:
    // the fake reads them at each frame, so lifted here they would let through a frame it had not come
    // to yet — the completing one, which makes the message whole and uncut. The interrupt's own frames
    // are written whatever the faults say.
    expect(app.runtime.stop(S(1))).toEqual({ status: 'stopping' });
    await idle(app);
    expect(answerOf(app)).toMatchObject({ state: 'partial', blocks: [{ cut: true }] });
    expect(itemText(answerOf(app) ?? { blocks: [] })).toHaveLength(MAX_MESSAGE_TEXT);
    await quit(app);
    const again = launch(h);
    expect(answerOf(again)).toMatchObject({ state: 'partial', blocks: [{ cut: true }] });
    expect(itemText(answerOf(again) ?? { blocks: [] })).toHaveLength(MAX_MESSAGE_TEXT);
  });

  it('keeps what was received of an answer when its process is lost between two deltas (exitBetweenDeltas)', async () => {
    const h = harness = await codexHarness();
    place(h);
    h.control({ exitBetweenDeltas: 1 });
    const app = launch(h);
    await app.runtime.send(S(1), PROMPTS.t1);
    await idle(app);
    const read = app.read(1);
    expect(answerOf(app)).toMatchObject({ state: 'partial', phase: 'final' });
    expect(itemText(answerOf(app) ?? { blocks: [] }).length).toBeGreaterThan(0);
    expect(read.turns[0]).toMatchObject({ state: 'unfinished' });
    expect(read.items.map((item) => item.notice ?? item.role)).toContain('connection-lost');
  });

  it('writes an open answer’s text at the quit, when the provider never confirms the Stop: partial under its stopped turn at the next launch', async () => {
    const h = harness = await codexHarness({ timings: { stopMs: 30_000 } });
    place(h);
    // The answer's deltas all arrive; its completing frame and the turn's end never do, and the Stop is never answered.
    h.control({ noCompletion: true, turnNeverEnds: true, hang: 'stop' });
    const app = launch(h);
    await app.runtime.send(S(1), PROMPTS.t1);
    await eventually(() => answerOf(app)?.phase === 'final' && itemText(answerOf(app) ?? { blocks: [] }).includes('Biscuit'), 20_000, 'the answer’s text');
    expect(answerOf(app)).toMatchObject({ state: 'streaming' });
    await quit(app);

    const again = launch(h);
    expect(answerOf(again)).toMatchObject({ state: 'partial', phase: 'final' });
    expect(itemText(answerOf(again) ?? { blocks: [] })).toContain('Biscuit');
    expect(again.read(1).turns[0]).toMatchObject({ state: 'unfinished', outcome: 'stopped' });
    expect(again.summary(1)?.status).not.toBe('running');
  });
});
