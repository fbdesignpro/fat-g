// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V6, V17, V26, V28 (docs/planning/_archive/M18.md, Design 6; C48–C53, C59, C61): Codex's history through the
// check, on the real adapter and process layer against the replay fake — in place of M15's paging
// loop, which read every message again at every start.
//
// The fake's history is the captured one: the saved thread's turn, and the turn traced after it. A
// thread that has played only the first has, in its history, a turn fat-g never ran: one made
// elsewhere.
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentProvider } from '@shared/provider-kit/provider';
import type { SessionFacet } from '@shared/provider-kit/sessions';
import { type App, launchApp, placeRecords, S, sessionEntry, storedSession } from '../sessions/app';
import { codexHarness, eventually, type Harness, PROMPTS } from './harness';

let harness: Harness | undefined;
let open: { readonly app: App; readonly provider?: AgentProvider }[] = [];
afterEach(async () => {
  for (const entry of open) { await entry.app.quit(); await entry.provider?.dispose(); }
  open = [];
  await harness?.dispose();
  harness = undefined;
});

const dataDir = (h: Harness) => path.join(h.dir, 'records');
const place = (h: Harness): void => placeRecords(dataDir(h), h.project, 'codex', [sessionEntry(1, 'codex', { model: 'gpt-6-astra' })]);
function launch(h: Harness, own?: { readonly provider: AgentProvider; readonly facet: SessionFacet }): App {
  const facet = own?.facet ?? h.facet;
  const app = launchApp({ dir: dataDir(h), descriptor: h.provider.descriptor, facet: () => facet, userDefault: () => 'ask-first' });
  open.push({ app, ...(own === undefined ? {} : { provider: own.provider }) });
  return app;
}
async function quit(app: App): Promise<void> {
  const entry = open.find((candidate) => candidate.app === app);
  open = open.filter((candidate) => candidate !== entry);
  await app.quit();
  await entry?.provider?.dispose();
}
const idle = (app: App) => eventually(() => !app.service.isRunning(S(1)), 15_000, 'the session coming to rest');
const state = (app: App) => app.read(1).history.state;
const checked = (app: App) => eventually(() => state(app) === 'checked', 10_000, 'the history check');
const reference = (h: Harness) => storedSession(dataDir(h), 1)?.['reference'] as string;
/** What the fake was asked of the thread's history, as `view×limit`, a cursor marked `@`. */
const reads = (h: Harness) => (h.threads()[reference(h)]?.historyReads ?? []).map((read) => `${read.view}×${String(read.limit)}${read.cursor ? '@' : ''}`);
const users = (app: App) => app.read(1).items.filter((item) => item.role === 'user').map((item) => item.blocks[0]?.text);
/** One run that sends these prompts on an adapter of its own, then quits. */
async function ran(h: Harness, prompts: readonly string[]): Promise<void> {
  const app = launch(h, await h.adapter());
  for (const prompt of prompts) {
    expect(await app.runtime.send(S(1), prompt)).toEqual({ status: 'accepted' });
    await idle(app);
  }
  await app.service.settled();
  await quit(app);
}

describe('the check, on Codex (V17; C51, C52)', () => {
  it('lists the turns without their items and, with nothing missing, reads no item', async () => {
    const h = harness = await codexHarness();
    place(h);
    // Both turns of the captured history were run by fat-g.
    await ran(h, [PROMPTS.saved, PROMPTS.resume]);
    const app = launch(h);
    const before = app.read(1).items;
    await app.select(1);
    await checked(app);
    expect(reads(h)).toEqual(['notLoaded×8']);
    expect(app.read(1).items).toEqual(before);
    expect(app.read(1).history).toEqual({ state: 'checked', olderUnread: false, earlierMissing: false });
    // It reached the start, and marked what it saw: the next start's check ends at its newest turn.
    expect(app.conversations.conversation(S(1))?.reachedStart).toBe(true);
    expect(app.conversations.newestPage(S(1)).turns.every((turn) => turn.reached)).toBe(true);
  });

  it('finds a turn made elsewhere, reads that turn alone and places it, and keeps what fat-g recorded as it was', async () => {
    const h = harness = await codexHarness();
    place(h);
    // fat-g ran the first turn, then one the provider's history does not hold under that id.
    await ran(h, [PROMPTS.saved, PROMPTS.t1]);
    const app = launch(h);
    const recorded = app.read(1).items;
    await app.select(1);
    await checked(app);
    // Listed; then walked a turn at a time, and only the one the store lacked read with its items.
    expect(reads(h)).toEqual(['notLoaded×8', 'notLoaded×1', 'full×1', 'notLoaded×1@']);
    const after = app.read(1);
    for (const item of recorded) expect(after.items.find((candidate) => candidate.id === item.id)).toEqual(item);
    const imported = after.items.filter((item) => item.origin === 'provider');
    // Its messages, and what it did between them (M20a, C19): the command it ran, in the provider's order.
    expect(imported.map((item) => (item.kind === 'activity' ? `activity:${item.activity?.type}:${item.activity?.status}` : item.role === 'assistant' ? `assistant:${item.phase}` : item.role))).toEqual(['user', 'assistant:commentary', 'activity:read:completed', 'assistant:final']);
    expect(imported.find((item) => item.kind === 'activity')).toMatchObject({ state: 'complete', workerId: null, activity: { name: 'commandExecution', exitCode: 0, duration: { provenance: 'provider' } } });
    expect(imported[0]?.blocks[0]?.text).toBe(PROMPTS.resume);
    // Newer than every turn both sides hold: last, after the turn only the store has (C49).
    expect(users(app)).toEqual([PROMPTS.saved, PROMPTS.t1, PROMPTS.resume]);
    // The provider's own times, never the local clock's (C4).
    const turn = after.turns.find((entry) => entry.origin === 'provider');
    expect(turn).toMatchObject({ state: 'ended', outcome: 'completed', time: { acceptedAt: null, endReceivedAt: null } });
    expect(typeof turn?.time.providerStartedAt).toBe('number');
    expect(imported.every((item) => item.time.receivedAt === null && item.time.providerAt === turn?.time.providerStartedAt)).toBe(true);
  });

  it('gives a prompt whose echo never came the provider’s ids, by the id it was sent with, and shows it once (V16; C53)', async () => {
    const h = harness = await codexHarness();
    place(h);
    await ran(h, [PROMPTS.saved]);
    const app = launch(h);
    const [prompt] = app.read(1).items;
    const turnId = prompt?.turnId ?? '';
    // As fat-g killed after the dispatch leaves it: neither the provider's turn id nor its item id.
    await quit(app);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(dataDir(h), 'conversations.sqlite'));
    db.prepare('UPDATE turn SET providerTurnId = NULL, providerTook = 0, providerOutcome = NULL, endReceivedAt = NULL WHERE id = ?').run(turnId);
    db.prepare('UPDATE item SET providerItemId = NULL WHERE id = ?').run(prompt?.id ?? '');
    db.close();

    const again = launch(h);
    expect(again.read(1).turns[0]).toMatchObject({ state: 'unacknowledged' });
    await again.select(1);
    await checked(again);
    const after = again.read(1);
    // The same item: its id, text and time kept, the provider's item id gained, and no second copy.
    expect(after.items.filter((item) => item.role === 'user' && item.blocks[0]?.text === PROMPTS.saved)).toHaveLength(1);
    expect(after.items.find((item) => item.id === prompt?.id)).toMatchObject({ origin: 'local', time: prompt?.time, providerItemId: prompt?.providerItemId });
    expect(after.turns.find((turn) => turn.id === turnId)).toMatchObject({ state: 'ended', outcome: 'completed' });
  });

  it('refuses a Send while the check runs, shows the stored chat when it fails, and takes the prompt then (V53)', async () => {
    const h = harness = await codexHarness();
    place(h);
    await ran(h, [PROMPTS.saved]);
    const app = launch(h);
    const recorded = app.read(1).items;
    h.control({ hang: 'history' });
    expect(app.runtime.loadHistory(S(1))).toEqual({ status: 'loading' });
    expect(await app.runtime.send(S(1), PROMPTS.resume)).toEqual({ status: 'refused', reason: 'history-loading' });
    await eventually(() => state(app) === 'failed', 10_000, 'the check failing');
    // A failed check hides nothing fat-g recorded (C18).
    expect(app.read(1).items).toEqual(recorded);
    h.control({});

    expect(await app.runtime.send(S(1), PROMPTS.resume)).toEqual({ status: 'accepted' });
    // Asked for during the turn: it waits for the session to be idle.
    expect(app.runtime.loadHistory(S(1))).toEqual({ status: 'waiting' });
    await idle(app);
    await checked(app);
    expect(users(app)).toEqual([PROMPTS.saved, PROMPTS.resume]);
    const ids = app.read(1).items.flatMap((item) => (item.providerItemId === null ? [] : [item.providerItemId]));
    expect(new Set(ids).size).toBe(ids.length);
    // Both turns were fat-g's own by then: no item of either was read.
    expect(reads(h).filter((read) => !read.startsWith('notLoaded'))).toEqual([]);
  });
});

describe('a turn Codex never ended for fat-g (V26; C59)', () => {
  it('stores no provider’s end when the process is lost during the turn, and takes the provider’s outcome at the next check', async () => {
    const h = harness = await codexHarness();
    place(h);
    const first = launch(h, await h.adapter());
    // The process ends once the turn has started, before its answer.
    h.control({ exitDuringTurn: 1 });
    expect(await first.runtime.send(S(1), PROMPTS.saved)).toEqual({ status: 'accepted' });
    await idle(first);
    await first.service.settled();
    const lost = first.read(1);
    // The session's end is written, to the record and the store; the provider's is not.
    expect(storedSession(dataDir(h), 1)?.['lastTurn']).toMatchObject({ outcome: 'failed' });
    expect(lost.turns[0]).toMatchObject({ state: 'unfinished', outcome: 'failed' });
    expect(first.conversations.lastLocalTurn(S(1))).toMatchObject({ providerOutcome: null, sessionOutcome: 'failed', providerTook: true });
    expect(lost.items.some((item) => item.notice === 'connection-lost')).toBe(true);
    await quit(first);

    // Codex had the turn, and finished it: the check reads it again, and it takes Codex's outcome.
    const app = launch(h);
    await app.select(1);
    await checked(app);
    const after = app.read(1);
    expect(after.turns[0]).toMatchObject({ id: lost.turns[0]?.id, state: 'ended', outcome: 'completed' });
    expect(after.items.some((item) => item.role === 'assistant' && item.phase === 'final' && item.origin === 'provider')).toBe(true);
    // The prompt is the one fat-g recorded, once, followed by the turn the captured history holds
    // after it, which fat-g never ran; the notice fat-g wrote is still there.
    expect(users(app)).toEqual([PROMPTS.saved, PROMPTS.resume]);
    expect(after.items.find((item) => item.role === 'user')).toMatchObject({ id: lost.items[0]?.id, origin: 'local' });
    expect(after.items.some((item) => item.notice === 'connection-lost')).toBe(true);
  });
});

describe('a check cut short (V28; C61)', () => {
  it('marks no turn when it fails after merging a page; Try again reads no item of what it then holds, and marks', async () => {
    const h = harness = await codexHarness();
    place(h);
    await ran(h, [PROMPTS.saved]);
    const app = launch(h);
    // The listing, one turn's place and that turn's items are answered; the next read never is.
    h.control({ hangHistoryAfter: 3 });
    await app.select(1);
    await eventually(() => state(app) === 'failed', 10_000, 'the check failing');
    // The page it merged stays…
    expect(users(app)).toEqual([PROMPTS.saved, PROMPTS.resume]);
    // …and nothing is marked: neither turn, nor the start.
    expect(app.conversations.newestPage(S(1)).turns.map((turn) => turn.reached)).toEqual([false, false]);
    expect(app.conversations.conversation(S(1))?.reachedStart).toBe(false);

    h.control({});
    const before = reads(h).length;
    expect(app.runtime.loadHistory(S(1))).toEqual({ status: 'loading' });
    await checked(app);
    // Both turns are held now: listed again, and no item read.
    expect(reads(h).slice(before)).toEqual(['notLoaded×8']);
    expect(app.conversations.newestPage(S(1)).turns.map((turn) => turn.reached)).toEqual([true, true]);
    expect(app.conversations.conversation(S(1))?.reachedStart).toBe(true);
    expect(users(app)).toEqual([PROMPTS.saved, PROMPTS.resume]);
  });
});
