// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V4, V7, V19, V26 (docs/planning/_archive/M19.md, Design 3; C9–C13, C18, C19, C55, C56, C60, C64): a reply as
// it is written, on the real Claude adapter and process layer against the replay fake, which is
// started for the launch that asks for partial messages and replays K2's captures — first as the
// adapter tells it, then through the app's own runtime, chat service and conversation store. Each
// fault is a captured frame with one named change (tests/fixtures/claude/replay.mjs).
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentEventSchema, MAX_MESSAGE_TEXT } from '@shared/contracts/agent-events';
import type { ChatPush } from '@shared/contracts/chat';
import { itemText } from '@shared/contracts/conversation';
import type { SessionFacet } from '@shared/provider-kit/sessions';
import type { ClaudeChatSession } from '../../../src/main/providers/claude/chat-session';
import { type App, launchApp, placeRecords, S, sessionEntry, storedSession } from '../../sessions/app';
import { foldDeltas } from '../../sessions/facet-contract';
import { claudeHarness, eventually, type Harness, type HarnessOptions, READING, REPLAYED, watch } from './harness';

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
const open = async (options?: HarnessOptions): Promise<Harness> => (harness = await claudeHarness(options));

const start = (h: Harness, facet: SessionFacet = h.facet) => watch(facet.start({ folder: h.project, model: 'sonnet', effort: 'low', speed: null, otherFolders: [], ...READING }));
type Started = ReturnType<typeof start>;
const counts = (session: Started) => (session.session as ClaudeChatSession).counts;
/** The session's own deltas and messages: what a worker of it says carries the worker's id (M20a, C20). */
const deltasOf = (session: Started) => session.events.flatMap((event) => (event.type === 'message-delta' && event.workerId === undefined ? [event] : []));
const said = (session: Started) => session.events.flatMap((event) => (event.type === 'message' && event.role === 'assistant' && event.workerId === undefined ? [event] : []));
const NO_DROPS = { 'other-thread': 0, 'other-turn': 0, 'unopened-item': 0, 'completed-item': 0, invalid: 0, oversized: 0, 'held-overflow': 0, 'other-worker': 0, 'ended-aside': 0 };

describe('a reply as the adapter tells it (V4, V19; C9–C13, C55)', () => {
  it('opens T1’s answer at its block’s start, grows it, and completes it by its frame; the reference comes before any of its text', async () => {
    const h = await open();
    const session = start(h);
    session.send(h.prompts.t1);
    const end = await session.ended('turn-1');
    expect(h.only().entry.turns).toEqual([REPLAYED.t1]);
    expect(h.only().entry.launches[0]?.args).toContain('--include-partial-messages');

    const folded = foldDeltas(session.events);
    expect(folded.faults).toEqual([]);
    expect(folded.open).toEqual([]);
    const [answer] = said(session);
    expect(answer).toMatchObject({ phase: 'commentary', text: 'The cat is called Biscuit.' });
    expect(answer?.itemId).toMatch(/#0$/);
    expect(folded.streamed.get(answer?.itemId ?? '')).toBe(answer?.text);
    // The completed end names the streamed message as the answer (C74).
    expect(end).toEqual({ type: 'turn-ended', turnId: 'turn-1', outcome: 'completed', reported: true, answerItemId: answer?.itemId });
    // At the first reply's start: before the read it holds, and before any text (C60).
    const types = session.types();
    expect(types.indexOf('session-started')).toBeLessThan(types.indexOf('action-changed'));
    expect(types.indexOf('session-started')).toBeLessThan(types.indexOf('message-delta'));
    expect(session.reference()).toBe(h.only().id);
    for (const event of session.events) expect(AgentEventSchema.safeParse(event).success, event.type).toBe(true);
    expect(counts(session).dropped).toEqual(NO_DROPS);
  });

  it('streams a long Markdown answer whole: its 267 deltas, a code block and a table', async () => {
    const h = await open();
    const session = start(h);
    session.send(h.prompts.markdown);
    expect((await session.ended('turn-1', 30_000)).outcome).toBe('completed');
    const folded = foldDeltas(session.events);
    const [answer] = said(session);
    expect(deltasOf(session).filter((delta) => delta.text !== '')).toHaveLength(267);
    expect(folded.streamed.get(answer?.itemId ?? '')).toBe(answer?.text);
    expect(answer?.text).toContain('```');
    expect(answer?.text).toMatch(/\|.*\|/);
    expect(counts(session).dropped).toEqual(NO_DROPS);
  });

  it('streams each text of T3 as its own message, and what its worker says under the worker’s id (M20a, C20, C22)', async () => {
    const h = await open();
    const session = start(h);
    session.send(h.prompts.t3);
    const end = await session.ended('turn-1', 30_000);
    const folded = foldDeltas(session.events);
    expect(folded.faults).toEqual([]);
    const texts = said(session);
    expect(texts).toHaveLength(2);
    for (const message of texts) expect(folded.streamed.get(message.itemId)).toBe(message.text);
    expect(new Set(deltasOf(session).map((delta) => delta.itemId))).toEqual(new Set(texts.map((message) => message.itemId)));
    expect(end).toMatchObject({ outcome: 'completed', answerItemId: texts[1]?.itemId });
    // The commentary is whole before the worker opens.
    expect(session.events.indexOf(texts[0] as never)).toBeLessThan(session.events.findIndex((event) => event.type === 'worker-started'));
    // What the worker was asked is the input of the session's own item that started it, and of no message of the session's.
    expect(JSON.stringify(texts)).not.toContain('notes-3.txt located');
    const [worker] = session.events.flatMap((event) => (event.type === 'worker-started' ? [event.workerId] : []));
    const launched = session.events.flatMap((event) => (event.type === 'activity-started' && event.activityType === 'worker' ? [event] : []));
    // One item, told three times: at its tool use, once the CLI named the worker it started (C21), and once
    // the worker's first frame named its model (M106, C14).
    expect(new Set(launched.map((event) => event.itemId)).size).toBe(1);
    expect(launched.map((event) => event.pairedWorkerId)).toEqual([undefined, worker, worker]);
    for (const event of launched) expect(event.workerId).toBeUndefined();
    expect(launched[0]?.input).toContain('notes-3.txt located');
    // What the worker did and said names it, and the turn that started it.
    const theirs = session.events.filter((event) => (event.type === 'message' || event.type === 'message-delta' || event.type === 'activity-started' || event.type === 'activity-ended') && event.workerId !== undefined);
    expect(theirs.length).toBeGreaterThan(0);
    expect(theirs.every((event) => 'workerId' in event && event.workerId === worker && 'turnId' in event && event.turnId === 'turn-1')).toBe(true);
  });

  it('leaves an interrupted answer as it was received: the frame the CLI sends with it does not complete it (C80)', async () => {
    const h = await open();
    const session = start(h);
    session.send(h.prompts.t4);
    await session.until((event) => event.type === 'message-delta' && event.text !== '');
    session.session.stop();
    expect(await session.ended('turn-1')).toEqual({ type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: true });
    const folded = foldDeltas(session.events);
    expect(folded.faults).toEqual([]);
    // No whole message: the text stays open, for the chat to keep as unfinished, with no phase said.
    expect(said(session)).toEqual([]);
    expect(folded.open).toHaveLength(1);
    expect(folded.streamed.get(folded.open[0] ?? '')).toBe('Summ');
    expect(deltasOf(session).every((delta) => delta.phase === null)).toBe(true);
  });
});

describe('each fault, one named change to the answer (V19; C56)', () => {
  it('wholeDiffers: the whole message carries another text than its deltas brought', async () => {
    const h = await open();
    h.control({ wholeDiffers: true });
    const session = start(h);
    session.send(h.prompts.t1);
    await session.ended('turn-1');
    const [answer] = said(session);
    const streamed = foldDeltas(session.events).streamed.get(answer?.itemId ?? '');
    expect(streamed).toBe('The cat is called Biscuit.');
    expect(answer?.text).toBe('The cat is called Biscuit. (as completed)');
  });

  it('noCompletion: the answer’s frame never comes, and the turn’s completed end still names the message its deltas opened', async () => {
    const h = await open();
    h.control({ noCompletion: true });
    const session = start(h);
    session.send(h.prompts.t1);
    const end = await session.ended('turn-1');
    expect(said(session)).toEqual([]);
    const folded = foldDeltas(session.events);
    expect(folded.open).toHaveLength(1);
    expect(folded.streamed.get(folded.open[0] ?? '')).toBe('The cat is called Biscuit.');
    expect(end).toMatchObject({ outcome: 'completed', reported: true, answerItemId: folded.open[0] });
  });

  it('noDeltas: the answer’s reply sends no stream event, so it arrives whole, under its frame’s own id', async () => {
    const h = await open();
    h.control({ noDeltas: true });
    const session = start(h);
    session.send(h.prompts.t3);
    const end = await session.ended('turn-1', 30_000);
    const texts = said(session);
    // The commentary streamed; the answer did not.
    expect(new Set(deltasOf(session).map((delta) => delta.itemId))).toEqual(new Set([texts[0]?.itemId]));
    expect(texts[1]?.itemId).not.toContain('#');
    expect(end).toMatchObject({ outcome: 'completed', answerItemId: texts[1]?.itemId });
    expect(counts(session).dropped).toEqual(NO_DROPS);
  });

  it('deltaOfWorker: text deltas that name a worker’s tool use are passed over, uncounted; the session’s own frame completes the message', async () => {
    const h = await open();
    h.control({ deltaOfWorker: true });
    const session = start(h);
    session.send(h.prompts.t1);
    await session.ended('turn-1');
    const [answer] = said(session);
    expect(deltasOf(session).map((delta) => [delta.itemId, delta.text])).toEqual([[answer?.itemId, '']]);
    expect(answer?.text).toBe('The cat is called Biscuit.');
    expect(counts(session).dropped).toEqual(NO_DROPS);
  });

  it('deltaAfterComplete: the answer’s last delta, sent again after its frame, is dropped and counted', async () => {
    const h = await open();
    h.control({ deltaAfterComplete: true });
    const session = start(h);
    session.send(h.prompts.t1);
    await session.ended('turn-1');
    expect(foldDeltas(session.events).faults).toEqual([]);
    expect(counts(session).dropped).toEqual({ ...NO_DROPS, 'completed-item': 1 });
    expect(h.diagnostics().filter((event) => event.type === 'frame-dropped')).toEqual([{ type: 'frame-dropped', reason: 'completed-item' }]);
  });

  it('deltasPastBound: each text delta is 20 000 units, so the answer’s pass a message’s bound', async () => {
    const h = await open();
    h.control({ deltasPastBound: true });
    const session = start(h);
    session.send(h.prompts.markdown);
    await session.ended('turn-1', 30_000);
    const written = deltasOf(session).filter((delta) => delta.text !== '');
    expect(written.every((delta) => delta.text.length === 20_000)).toBe(true);
    expect(written.length * 20_000).toBeGreaterThan(MAX_MESSAGE_TEXT);
    for (const event of session.events) expect(AgentEventSchema.safeParse(event).success, event.type).toBe(true);
  });

  it('exitBetweenDeltas: the process ends after the answer’s second delta, and the turn ends with it, its message open', async () => {
    const h = await open();
    h.control({ exitBetweenDeltas: 1 });
    const session = start(h);
    session.send(h.prompts.markdown);
    expect(await session.ended('turn-1', 30_000)).toEqual({ type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: false, failure: 'connection-lost' });
    const folded = foldDeltas(session.events);
    expect(folded.open).toHaveLength(1);
    expect(deltasOf(session).filter((delta) => delta.text !== '')).toHaveLength(2);
    expect(session.notices()).toEqual(['connection-lost']);
    // The reference had come, at the reply's start: the session can be resumed (C60).
    expect(session.reference()).toBe(h.only().id);
  });
});

// ── Through the app ───────────────────────────────────────────────────────────────────────────
const dataDir = (h: Harness): string => path.join(h.dir, 'records');
const place = (h: Harness): void => placeRecords(dataDir(h), h.project, 'claude', [sessionEntry(1, 'claude', { model: 'sonnet' })]);
function launch(h: Harness, facet: SessionFacet = h.facet): App {
  const app = launchApp({ dir: dataDir(h), descriptor: h.provider.descriptor, facet: () => facet, log });
  apps.push(app);
  return app;
}
async function quit(app: App): Promise<void> {
  apps = apps.filter((candidate) => candidate !== app);
  await app.quit();
}
/** Ends a run as the app's quit does, with its adapter, and answers the next run's facet. */
async function restart(h: Harness, app: App): Promise<SessionFacet> {
  await quit(app);
  await h.provider.dispose();
  await eventually(() => h.running('chat').length === 0, 15_000, 'the session’s process ending');
  return (await h.adapter()).facet;
}
const idle = (app: App) => eventually(() => !app.service.isRunning(S(1)), 30_000, 'the session coming to rest');
const kinds = (pushes: readonly ChatPush[]) => pushes.map((push) => ('item' in push ? `item:${push.item.role}:${push.item.state}` : 'partial' in push ? 'partial' : 'changed'));
const answerOf = (app: App) => app.read(1).items.findLast((item) => item.role === 'assistant');
const textOf = (app: App): string => itemText(answerOf(app) ?? { blocks: [] });

describe('a reply through the app (V4, V7, V26; C14, C18, C19, C60, C64)', () => {
  it('shows the answer from its opening, streaming, then complete under the same id; named by the end, it reads final', async () => {
    const h = await open();
    place(h);
    const app = launch(h);
    expect(await app.runtime.send(S(1), h.prompts.markdown)).toEqual({ status: 'accepted' });
    await idle(app);
    await app.service.settled();
    const mine = kinds(app.pushes).filter((kind) => kind.startsWith('item:assistant') || kind === 'partial');
    expect(mine[0]).toBe('item:assistant:streaming');
    expect(mine.at(-1)).toBe('item:assistant:complete');
    expect(mine.filter((kind) => kind === 'partial').length).toBeGreaterThan(0);
    const ids = new Set(app.pushes.flatMap((push) => ('item' in push && push.item.role === 'assistant' ? [push.item.id] : [])));
    expect(ids.size).toBe(1);
    // While it was written it said no phase (C79): Claude names the answer at the turn's end, and the
    // page draws a text that says none as it draws an answer. Whole, it was commentary for a moment,
    // as every text of Claude's is; the completed end named it the answer.
    expect(app.pushes.flatMap((push) => ('item' in push && push.item.role === 'assistant' && push.item.state === 'streaming' ? [push.item.phase] : []))).toEqual([null]);
    expect(app.pushes.flatMap((push) => ('item' in push && push.item.role === 'assistant' && push.item.state === 'complete' ? [push.item.phase] : []))).toEqual(['commentary']);
    expect(app.read(1).items.map((item) => `${item.role}:${item.phase}:${item.state}`)).toEqual(['user:null:complete', 'assistant:final:complete']);
    expect(textOf(app)).toContain('```');
    expect(app.chat.dropped()).toEqual({ bound: 0, 'turn-ended': 0, complete: 0, unopened: 0 });
    // No text of it in a log, and none in the summary (C23).
    expect(JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls])).not.toContain('tide table');
    expect(JSON.stringify(app.service.snapshot())).not.toContain('high tide');
    // The same after a restart, from the store.
    const facet = await restart(h, app);
    const again = launch(h, facet);
    expect(again.read(1).items.map((item) => `${item.role}:${item.phase}:${item.state}`)).toEqual(['user:null:complete', 'assistant:final:complete']);
    expect(textOf(again)).toContain('```');
  });

  it('keeps an answer its Stop cut as unfinished, as far as it was written, with the line that says so; the same after a restart (C80)', async () => {
    const h = await open();
    place(h);
    const app = launch(h);
    await app.runtime.send(S(1), h.prompts.t4);
    await eventually(() => app.pushes.some((push) => 'partial' in push || ('item' in push && push.item.role === 'assistant' && itemText(push.item) !== '')), 20_000, 'part of the answer');
    expect(app.runtime.stop(S(1))).toEqual({ status: 'stopping' });
    await idle(app);
    await app.service.settled();
    // Partial is what the page draws the incomplete line for; no phase, so it is drawn as an answer is.
    expect(answerOf(app)).toMatchObject({ state: 'partial', phase: null });
    expect(textOf(app)).toBe('Summ');
    expect(app.read(1).turns[0]).toMatchObject({ state: 'ended', outcome: 'interrupted' });
    expect(app.read(1).items.filter((item) => item.kind !== 'activity').map((item) => item.notice ?? item.role)).toEqual(['user', 'assistant']);
    // What it did before the Stop is kept with it (M20a, C29), and none of it reads as running under an ended turn.
    const done = app.read(1).items.filter((item) => item.kind === 'activity');
    expect(done.length).toBeGreaterThan(0);
    expect(done.every((item) => item.activity?.status !== 'running' && item.state === 'complete')).toBe(true);
    const facet = await restart(h, app);
    const again = launch(h, facet);
    expect(answerOf(again)).toMatchObject({ state: 'partial', phase: null });
    expect(textOf(again)).toBe('Summ');
  });

  it('takes the whole message’s text where the deltas brought another (wholeDiffers)', async () => {
    const h = await open();
    place(h);
    h.control({ wholeDiffers: true });
    const app = launch(h);
    await app.runtime.send(S(1), h.prompts.t1);
    await idle(app);
    expect(textOf(app)).toBe('The cat is called Biscuit. (as completed)');
    expect(answerOf(app)).toMatchObject({ state: 'complete', phase: 'final' });
  });

  it('leaves an answer partial under a finished turn when its frame never comes, named the answer all the same (noCompletion)', async () => {
    const h = await open();
    place(h);
    h.control({ noCompletion: true });
    const app = launch(h);
    await app.runtime.send(S(1), h.prompts.t1);
    await idle(app);
    await app.service.settled();
    expect(answerOf(app)).toMatchObject({ state: 'partial', phase: 'final' });
    expect(textOf(app)).toBe('The cat is called Biscuit.');
    expect(app.read(1).turns[0]).toMatchObject({ state: 'ended', outcome: 'completed', gap: false });
    // After a restart it reads the same: partial, and never streaming. Claude gives no history back to complete it by.
    const facet = await restart(h, app);
    const again = launch(h, facet);
    expect(answerOf(again)).toMatchObject({ state: 'partial', phase: 'final' });
    expect(again.read(1).history.state).toBe('unsupported');
  });

  it('says a message was cut while it still streams, and keeps it partial and cut through a Stop and a restart (deltasPastBound, no frame)', async () => {
    const h = await open();
    place(h);
    h.control({ deltasPastBound: true, noCompletion: true, turnNeverEnds: true });
    const app = launch(h);
    await app.runtime.send(S(1), h.prompts.markdown);
    const atBound = await eventually(() => app.pushes.find((push) => 'item' in push && push.item.blocks[0]?.cut === true), 30_000, 'the push at the bound');
    if (!('item' in atBound)) throw new Error('not an item push');
    expect(atBound.item).toMatchObject({ state: 'streaming' });
    expect(itemText(atBound.item)).toHaveLength(MAX_MESSAGE_TEXT);
    expect(app.chat.dropped().bound).toBeGreaterThan(0);

    h.control({});
    await eventually(() => app.runtime.stop(S(1)).status === 'stopping' || !app.service.isRunning(S(1)), 10_000, 'the Stop being taken');
    await idle(app);
    expect(answerOf(app)).toMatchObject({ state: 'partial', blocks: [{ cut: true }] });
    expect(textOf(app)).toHaveLength(MAX_MESSAGE_TEXT);
    const facet = await restart(h, app);
    const again = launch(h, facet);
    expect(answerOf(again)).toMatchObject({ state: 'partial', blocks: [{ cut: true }] });
    expect(textOf(again)).toHaveLength(MAX_MESSAGE_TEXT);
  });

  it('keeps what was received of an answer when its process is lost between two deltas (exitBetweenDeltas)', async () => {
    const h = await open();
    place(h);
    h.control({ exitBetweenDeltas: 1 });
    const app = launch(h);
    await app.runtime.send(S(1), h.prompts.markdown);
    await idle(app);
    await app.service.settled();
    const read = app.read(1);
    // Never completed, and never named: it keeps the phase it was written with, none.
    expect(answerOf(app)).toMatchObject({ state: 'partial', phase: null });
    expect(textOf(app).length).toBeGreaterThan(0);
    expect(read.turns[0]).toMatchObject({ state: 'unfinished' });
    expect(read.items.map((item) => item.notice ?? item.role)).toContain('connection-lost');
  });

  it('a first answer cut by force: the reference was stored at the reply’s start, the text received is kept partial, and the next prompt resumes the conversation (C60)', async () => {
    const h = await open();
    place(h);
    const app = launch(h);
    // K2's first prompt: the process is ended by force during the reply's first text block.
    expect(await app.runtime.send(S(1), h.prompts.cut)).toEqual({ status: 'accepted' });
    await idle(app);
    await app.service.settled();
    const { id, entry } = h.only();
    expect(entry.turns).toEqual(['m19-cut-cut']);
    // No frame from a model ever came — the reply was cut inside its first block — and the reference is there.
    expect(storedSession(dataDir(h), 1)?.['reference']).toBe(id);
    expect(app.conversations.conversation(S(1))).toMatchObject({ reference: id, folder: h.project });
    expect(answerOf(app)).toMatchObject({ state: 'partial', phase: null });
    const received = textOf(app);
    expect(received.length).toBeGreaterThan(100);
    // The end is the session's own: Claude gave none, so the turn reads unfinished (M16, C76).
    expect(app.read(1).turns[0]).toMatchObject({ state: 'unfinished', outcome: 'failed' });
    expect(app.read(1).items.map((item) => item.notice ?? item.role)).toEqual(['user', 'assistant', 'connection-lost']);

    // The next prompt: a new process, resumed by that reference, answers; the cut answer stays as received.
    expect(await app.runtime.send(S(1), h.prompts.cutResumed)).toEqual({ status: 'accepted' });
    await idle(app);
    await app.service.settled();
    const after = h.only().entry;
    expect(after.turns).toEqual(['m19-cut-cut', 'm19-cut-resumed']);
    expect(after.launches.map((made) => made.resume)).toEqual([null, id]);
    const items = app.read(1).items;
    expect(items.filter((item) => item.role === 'assistant').map((item) => `${String(item.phase)}:${item.state}`)).toEqual(['null:partial', 'final:complete']);
    expect(itemText(items.filter((item) => item.role === 'assistant')[0] ?? { blocks: [] })).toBe(received);
    expect(app.read(1).turns.map((turn) => [turn.state, turn.outcome])).toEqual([['unfinished', 'failed'], ['ended', 'completed']]);
  });

  it('writes an open answer’s text at the quit: partial under its stopped turn at the next launch', async () => {
    // Slowly enough for the quit to come while the answer is written.
    const h = await open({ env: { FATG_SMOKE_CLAUDE_GAP_MS: '25' } });
    place(h);
    const app = launch(h);
    await app.runtime.send(S(1), h.prompts.markdown);
    await eventually(() => app.pushes.some((push) => 'partial' in push), 20_000, 'part of the answer');
    expect(answerOf(app)).toMatchObject({ state: 'streaming' });
    const facet = await restart(h, app);
    const again = launch(h, facet);
    const answer = answerOf(again);
    expect(answer).toMatchObject({ state: 'partial', phase: null });
    expect(textOf(again).length).toBeGreaterThan(0);
    expect(textOf(again).length).toBeLessThan(3_134);
    expect(again.read(1).turns[0]?.state).not.toBe('running');
  });
});
