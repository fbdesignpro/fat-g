// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V13, V14, V22, V30 (docs/planning/_archive/M18.md, Design 7–9; C27–C33, C54, C55, C63): records.json and the
// conversation store, each taken through a fault of its own after the other's write landed, and
// through missing, refused, set aside and restored. After each, a restart: the session's status,
// whether its next prompt starts or resumes, and its chat must agree — with one start of the
// provider's session in all, and no prompt sent twice.
//
// The app's session side is the real one (tests/sessions/app.ts); the provider is a facet in the
// test's hands, which names no provider.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderDescriptor } from '@shared/contracts/provider';
import { STORE_FILE, storeFiles } from '../../src/main/conversations/format';
import { RECORDS_FILE } from '../../src/main/records/format';
import { writeFileAtomic } from '../../src/main/storage/atomic-write';
import { type FakeFacet, fakeFacet, historyTurn, pagedHistory } from '../../src/main/sessions/runtime-test-support';
import { EXAMPLE_DESCRIPTOR } from '../support/example-provider';
import { type App, launchApp, placeRecords, S, sessionEntry, storedSession, until } from './app';

const DESCRIPTOR: ProviderDescriptor = { ...EXAMPLE_DESCRIPTOR, capabilities: { ...EXAMPLE_DESCRIPTOR.capabilities, sessions: true, history: true } };
const REFERENCE = 'provider-session-1';
const PROMPT = 'What is the cat’s name?';
/** The line a run adds, once, when a session's entry could not be saved: it is kept with the chat (C10, C46). */
const UNSAVED = 'session-unsaved: This session could not be saved to fat-g’s list. The conversation goes on.';

let root: string;
let dir: string;
let folder: string;
let apps: App[];
/** Every facet a launch was given, in order: what was started, resumed and sent across the runs. */
let fakes: FakeFacet[];
/** What fails now: a records write whose text holds this, and a store transaction of this name. */
let faults: { records: ((text: string) => boolean) | null; store: string | null };

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'fatg-two-stores-'));
  dir = path.join(root, 'data');
  folder = path.join(root, 'project');
  mkdirSync(folder);
  apps = [];
  fakes = [];
  faults = { records: null, store: null };
  placeRecords(dir, folder, DESCRIPTOR.id, [sessionEntry(1, DESCRIPTOR.id)]);
});
afterEach(() => {
  for (const app of apps) app.drop();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** One run of the app on the data folder as it is. */
function launch(): { readonly app: App; readonly fake: FakeFacet } {
  const fake = fakeFacet();
  const app = launchApp({
    dir, descriptor: DESCRIPTOR, facet: () => fake.facet,
    records: { write: (target, text) => (faults.records?.(text) === true ? Promise.reject(Object.assign(new Error('disk'), { code: 'EIO' })) : writeFileAtomic(target, text)) },
    store: { hook: (point) => { if (faults.store === point) throw Object.assign(new Error('disk'), { code: 'EIO' }); } },
  });
  apps.push(app);
  fakes.push(fake);
  return { app, fake };
}
/** The run ends without a quit: nothing more is written. */
const crash = (app: App): void => { app.drop(); };

interface Played { readonly turnId: string; readonly messageId: string }
/** A prompt accepted and taken by the provider: the turn runs. */
async function begin(app: App, fake: FakeFacet, prompt = PROMPT): Promise<Played> {
  expect(await app.runtime.send(S(1), prompt)).toEqual({ status: 'accepted' });
  const sent = fake.latest().sent.at(-1);
  if (sent === undefined) throw new Error('nothing was sent');
  fake.latest().emit({ type: 'turn-started', turnId: sent.turnId, providerTurnId: `p-${sent.turnId}` });
  if (fake.latest().kind === 'start') fake.latest().emit({ type: 'session-started', reference: REFERENCE, folder });
  fake.latest().emit({ type: 'message', turnId: sent.turnId, role: 'user', itemId: `u-${sent.turnId}`, phase: null, text: prompt, clientId: sent.messageId });
  return { turnId: sent.turnId, messageId: sent.messageId };
}
/** The provider's answer and its own end of the turn. */
async function finish(app: App, fake: FakeFacet, played: Played): Promise<void> {
  fake.latest().emit({ type: 'message', turnId: played.turnId, role: 'assistant', itemId: `a-${played.turnId}`, phase: 'final', text: 'Miso.' });
  fake.latest().emit({ type: 'turn-ended', turnId: played.turnId, outcome: 'completed', reported: true });
  await app.service.settled();
}
async function turn(app: App, fake: FakeFacet, prompt = PROMPT): Promise<Played> {
  const played = await begin(app, fake, prompt);
  await finish(app, fake, played);
  return played;
}
const record = () => storedSession(dir, 1);
/** Every session the provider was asked for across the runs, and every prompt it was sent. */
const asked = () => fakes.flatMap((fake) => fake.made.map((made) => made.kind));
const sentPrompts = () => fakes.flatMap((fake) => fake.made.flatMap((made) => made.sent.map((sent) => sent.prompt)));
const checked = (app: App) => until(() => app.read(1).history.state === 'checked', 'the history check');
const corrupt = (): string => { const good = readFileSync(path.join(dir, RECORDS_FILE), 'utf8'); writeFileSync(path.join(dir, RECORDS_FILE), '{'); return good; };

describe('a write that failed in one store after the other’s landed (V13; C27–C29, C54)', () => {
  it('the reference, lost by the record: the session reads started, its chat is there, and its next prompt resumes — one start in all', async () => {
    const first = launch();
    faults.records = (text) => text.includes(REFERENCE);
    await turn(first.app, first.fake);
    expect(record()?.['reference']).toBeNull();
    expect(first.app.conversations.conversation(S(1))).toMatchObject({ reference: REFERENCE, folder });
    crash(first.app);

    faults.records = null;
    const { app, fake } = launch();
    // Reconciled before any window: idle, not "not started".
    expect(app.summary(1)?.status).toBe('idle');
    expect(app.runtime.kept(S(1))).toEqual({ reference: REFERENCE, folder });
    expect(app.texts(1)).toEqual([`user: ${PROMPT}`, 'assistant: Miso.', UNSAVED]);
    // Its history is checked, not called checked already, as a session that never started would be.
    expect(app.read(1).history.state).toBe('not-checked');
    await app.service.settled();
    expect(record()).toMatchObject({ reference: REFERENCE });
    await app.select(1);
    await checked(app);
    await turn(app, fake, 'And its age?');
    expect(asked()).toEqual(['start', 'resume']);
    expect(fake.latest().options.reference).toBe(REFERENCE);
    expect(sentPrompts()).toEqual([PROMPT, 'And its age?']);
  });

  it('the reference, lost by the record again at the next launch: it still resumes, and says so once', async () => {
    const first = launch();
    faults.records = (text) => text.includes(REFERENCE);
    await turn(first.app, first.fake);
    crash(first.app);

    const { app, fake } = launch();
    await app.service.settled();
    expect(record()?.['reference']).toBeNull();
    expect(app.summary(1)?.status).toBe('idle');
    await app.select(1);
    await checked(app);
    await turn(app, fake, 'And its age?');
    expect(asked()).toEqual(['start', 'resume']);
    // Said once a run, and nothing of a restart (C46): the earlier run's line is kept with the chat,
    // and this run added one, though the write failed at the launch and again at the prompt.
    expect(app.texts(1).filter((line) => line === UNSAVED)).toHaveLength(2);
    expect(app.texts(1).filter((line) => line.startsWith('session-unsaved'))).toHaveLength(2);
  });

  it('the reference, lost by the store: the record’s is never replaced, and the next prompt resumes', async () => {
    const first = launch();
    faults.store = 'reference';
    await turn(first.app, first.fake);
    expect(record()).toMatchObject({ reference: REFERENCE });
    expect(first.app.conversations.conversation(S(1))?.reference).toBeNull();
    crash(first.app);

    faults.store = null;
    const { app, fake } = launch();
    expect(app.summary(1)?.status).toBe('idle');
    await app.select(1);
    await checked(app);
    await turn(app, fake, 'again');
    expect(asked()).toEqual(['start', 'resume']);
    expect(record()).toMatchObject({ reference: REFERENCE });
  });

  it('a turn’s start, lost by the record: the record takes the turn, the session reads STOPPED, and nothing is sent again', async () => {
    const first = launch();
    await turn(first.app, first.fake);
    // The second turn's start never reaches the file; the process is then lost.
    faults.records = () => true;
    const played = await begin(first.app, first.fake, 'A second prompt');
    await first.app.service.settled();
    expect((record()?.['lastTurn'] as { turnId: string }).turnId).not.toBe(played.turnId);
    crash(first.app);

    faults.records = null;
    const { app } = launch();
    // The turn only the store holds is the record's last turn now, without an end: STOPPED (M14, C74).
    expect(app.summary(1)?.attention).toMatchObject({ kind: 'stopped' });
    await app.service.settled();
    expect(record()?.['lastTurn']).toMatchObject({ turnId: played.turnId, endedAt: null, outcome: null });
    // Its content is whole, the turn reads unfinished, and no path sent its prompt again.
    expect(app.texts(1)).toEqual([`user: ${PROMPT}`, 'assistant: Miso.', 'user: A second prompt']);
    expect(app.read(1).turns.at(-1)).toMatchObject({ id: played.turnId, state: 'unfinished', outcome: null });
    expect(sentPrompts()).toEqual([PROMPT, 'A second prompt']);
    expect(fakes[1]?.made).toEqual([]);
  });

  it('the session’s end, lost by the record: the record takes it from the store, and the session does not read STOPPED', async () => {
    const first = launch();
    const played = await begin(first.app, first.fake);
    await first.app.service.settled();
    faults.records = (text) => text.includes('"outcome": "completed"');
    await finish(first.app, first.fake, played);
    expect(record()?.['lastTurn']).toMatchObject({ turnId: played.turnId, endedAt: null });
    crash(first.app);

    faults.records = null;
    const { app } = launch();
    // Not STOPPED: READY, seen, as a launch reads a finished turn (C106, amended).
    expect(app.summary(1)?.attention).toEqual({ kind: 'ready', count: 1, acknowledged: true });
    await app.service.settled();
    expect(record()?.['lastTurn']).toMatchObject({ turnId: played.turnId, outcome: 'completed' });
    expect(typeof (record()?.['lastTurn'] as { endedAt: unknown }).endedAt).toBe('number');
  });

  it('the session’s end, lost by the store: the store takes it from the record', async () => {
    const first = launch();
    const played = await begin(first.app, first.fake);
    faults.store = 'session-end';
    await finish(first.app, first.fake, played);
    expect(record()?.['lastTurn']).toMatchObject({ outcome: 'completed' });
    expect(first.app.conversations.turn(S(1), played.turnId)).toMatchObject({ sessionOutcome: null, providerOutcome: 'completed' });
    crash(first.app);

    faults.store = null;
    const { app } = launch();
    expect(app.conversations.turn(S(1), played.turnId)).toMatchObject({ sessionOutcome: 'completed', providerOutcome: 'completed' });
    // Not STOPPED: READY, seen, as a launch reads a finished turn (C106, amended).
    expect(app.summary(1)?.attention).toEqual({ kind: 'ready', count: 1, acknowledged: true });
  });

  it('never takes the provider’s end as the session’s: killed after the provider’s end while a worker ran, it reads STOPPED, its content whole (V23)', async () => {
    const first = launch();
    const played = await begin(first.app, first.fake);
    first.fake.latest().emit({ type: 'worker-started', workerId: 'w1' });
    await finish(first.app, first.fake, played);
    // The provider's turn is over; the session still runs on its worker. Then fat-g is killed.
    expect(first.app.service.isRunning(S(1))).toBe(true);
    expect(first.app.conversations.turn(S(1), played.turnId)).toMatchObject({ providerOutcome: 'completed', sessionOutcome: null });
    crash(first.app);

    const { app } = launch();
    await app.service.settled();
    expect(record()?.['lastTurn']).toMatchObject({ turnId: played.turnId, endedAt: null, outcome: null });
    expect(app.summary(1)?.attention).toMatchObject({ kind: 'stopped' });
    expect(app.texts(1)).toEqual([`user: ${PROMPT}`, 'assistant: Miso.']);
    expect(app.read(1).turns[0]).toMatchObject({ state: 'ended', outcome: 'completed' });
  });

  it('writes a quit’s stopped end to both while a worker runs, and keeps the provider’s outcome (V23; C45)', async () => {
    const first = launch();
    const played = await begin(first.app, first.fake);
    first.fake.latest().emit({ type: 'worker-started', workerId: 'w1' });
    await finish(first.app, first.fake, played);
    await first.app.quit();
    expect(record()?.['lastTurn']).toMatchObject({ turnId: played.turnId, outcome: 'stopped' });

    const { app } = launch();
    expect(app.conversations.turn(S(1), played.turnId)).toMatchObject({ providerOutcome: 'completed', sessionOutcome: 'stopped' });
    // The turn's own outcome is the provider's; the session reads STOPPED.
    expect(app.read(1).turns[0]).toMatchObject({ state: 'ended', outcome: 'completed' });
    expect(app.summary(1)?.attention).toMatchObject({ kind: 'stopped' });
  });
});

describe('records refused at launch, then Try again (V22; C28, C29, C31, C55)', () => {
  /** A first run whose record took neither the reference nor the turn, then records the next launch cannot read. */
  async function refusedAtLaunch(): Promise<{ readonly played: Played; readonly good: string }> {
    const first = launch();
    faults.records = () => true;
    const played = await turn(first.app, first.fake);
    expect(record()).toMatchObject({ reference: null, lastTurn: null });
    crash(first.app);
    faults.records = null;
    return { played, good: corrupt() };
  }

  it('reconciles in the step that lists the session: the reference, the turn and its end are the record’s before a check or a Send', async () => {
    const { played, good } = await refusedAtLaunch();
    const { app, fake } = launch();
    expect(app.records.isRefused()).toBe(true);
    // No session is listed: its chat is detached, kept, and counted.
    expect(app.follower.detached().map((entry) => entry.id)).toEqual([S(1)]);
    // The prompt, the answer, and the line that its entry could not be saved.
    expect(app.conversations.newestPage(S(1)).items).toHaveLength(3);

    writeFileSync(path.join(dir, RECORDS_FILE), good);
    expect(app.records.retry()).toEqual({ status: 'loaded' });
    // In that same step, with nothing awaited: attached again by its id, and reconciled.
    expect(app.follower.detached()).toEqual([]);
    expect(app.runtime.kept(S(1))).toEqual({ reference: REFERENCE, folder });
    expect(app.summary(1)).toMatchObject({ status: 'idle', attention: { kind: 'ready', count: 1, acknowledged: true } });
    expect(app.read(1).history.state).toBe('not-checked');
    expect(fake.reads).toEqual([]);
    await app.service.settled();
    expect(record()).toMatchObject({ reference: REFERENCE, lastTurn: { turnId: played.turnId, outcome: 'completed' } });

    // Its next prompt waits for the check, then resumes the provider's session.
    expect(await app.runtime.send(S(1), 'again')).toEqual({ status: 'refused', reason: 'history-loading' });
    await checked(app);
    await turn(app, fake, 'again');
    expect(asked()).toEqual(['start', 'resume']);
    expect(sentPrompts()).toEqual([PROMPT, 'again']);
  });

  it('resumes also when the reference’s write fails again', async () => {
    const { good } = await refusedAtLaunch();
    const { app, fake } = launch();
    faults.records = (text) => text.includes(REFERENCE);
    writeFileSync(path.join(dir, RECORDS_FILE), good);
    app.records.retry();
    await app.service.settled();
    expect(record()?.['reference']).toBeNull();
    expect(app.summary(1)?.status).toBe('idle');
    await app.select(1);
    await checked(app);
    await turn(app, fake, 'again');
    expect(asked()).toEqual(['start', 'resume']);
  });
});

describe('each store missing, refused, set aside and restored (V14; C30–C33)', () => {
  /** A run that records one turn, then quits. */
  async function recorded(): Promise<void> {
    const { app, fake } = launch();
    await turn(app, fake);
    await app.quit();
  }
  const rows = (app: App): number => app.conversations.newestPage(S(1)).items.length;

  it('keeps the chat when records.json is missing, counts it as detached, and attaches it again when the file returns', async () => {
    await recorded();
    renameSync(path.join(dir, RECORDS_FILE), path.join(root, 'kept-aside.json'));
    const without = launch().app;
    expect(without.service.snapshot().sessions).toEqual([]);
    expect(without.follower.detached().map((entry) => entry.id)).toEqual([S(1)]);
    expect(rows(without)).toBe(2);
    await without.quit();

    renameSync(path.join(root, 'kept-aside.json'), path.join(dir, RECORDS_FILE));
    const back = launch().app;
    expect(back.follower.detached()).toEqual([]);
    expect(back.texts(1)).toEqual([`user: ${PROMPT}`, 'assistant: Miso.']);
  });

  it('keeps the chat when records.json is set aside by Start fresh: it goes only through its own cleanup', async () => {
    await recorded();
    corrupt();
    const { app } = launch();
    expect(await app.records.startFresh()).toMatchObject({ status: 'done' });
    expect(app.service.snapshot().sessions).toEqual([]);
    expect(app.follower.detached().map((entry) => entry.id)).toEqual([S(1)]);
    expect(rows(app)).toBe(2);
    // Its own cleanup, on the user's word.
    app.removal.detached([S(1)]);
    expect(app.follower.detached()).toEqual([]);
    expect(app.conversations.conversation(S(1))).toBeNull();
  });

  it('starts an empty store when the conversation store is missing: the session stays, its earlier chat is said to be missing, and a check reads what the provider gives', async () => {
    await recorded();
    for (const file of storeFiles()) rmSync(path.join(dir, file), { force: true });
    const { app, fake } = launch();
    expect(app.summary(1)?.status).toBe('idle');
    expect(record()).toMatchObject({ reference: REFERENCE });
    expect(app.read(1)).toMatchObject({ items: [], storage: 'ok', history: { state: 'not-checked', earlierMissing: true } });
    fake.history = pagedHistory([historyTurn('p-earlier', [{ role: 'user', itemId: 'h1', phase: null, text: PROMPT }, { role: 'assistant', itemId: 'h2', phase: 'final', text: 'Miso.' }])]);
    await app.select(1);
    await checked(app);
    expect(app.texts(1)).toEqual([`user: ${PROMPT}`, 'assistant: Miso.']);
    expect(app.read(1).history.earlierMissing).toBe(false);
    // The conversation was made for a session that had already started: it does not claim its start.
    expect(app.conversations.conversation(S(1))).toMatchObject({ startHeld: false, reachedStart: true });
  });

  it('blocks Send while the conversation store is refused, leaves the records as they were, and takes a prompt after Start fresh', async () => {
    await recorded();
    writeFileSync(path.join(dir, STORE_FILE), Buffer.alloc(8192, 3));
    const before = readFileSync(path.join(dir, RECORDS_FILE), 'utf8');
    const { app, fake } = launch();
    expect(app.conversations.status()).toEqual({ kind: 'refused', cause: 'damaged' });
    // The session is listed, with its reference, and says why it takes no prompt.
    expect(app.service.snapshot().sessions[0]).toMatchObject({ block: 'conversations-refused', record: { id: S(1) } });
    expect(app.read(1)).toMatchObject({ items: [], storage: 'refused' });
    expect(await app.runtime.send(S(1), 'hello')).toEqual({ status: 'refused', reason: 'conversations-refused' });
    expect(app.runtime.loadHistory(S(1))).toEqual({ status: 'refused', reason: 'conversations-refused' });
    expect(fake.made).toEqual([]);
    expect(fake.reads).toEqual([]);
    expect(await app.removal.run([S(1)], () => app.service.remove(S(1)), (answer) => answer.status === 'saved')).toEqual({ status: 'refused', reason: 'conversations-refused' });
    await app.service.settled();
    expect(readFileSync(path.join(dir, RECORDS_FILE), 'utf8')).toBe(before);

    // Start fresh sets the store aside, unchanged; then main reconciles, and the session takes a prompt.
    expect(await app.conversations.startFresh()).toMatchObject({ status: 'done' });
    app.runtime.reconcile();
    app.service.availabilityChanged();
    expect(app.service.snapshot().sessions[0]?.block).toBeNull();
    expect(app.conversations.files.setAside()).toHaveLength(1);
    await app.select(1);
    await checked(app);
    await turn(app, fake, 'hello');
    expect(asked()).toEqual(['start', 'resume']);
    expect(readdirSync(dir).filter((name) => name.includes('set-aside'))).toHaveLength(1);
  });

  it('reads the chat again when a set-aside store is put back, and never reads one by itself (C41)', async () => {
    await recorded();
    // As Start fresh leaves it, done by hand: the store moved aside under its dated name.
    const aside = 'conversations.set-aside.2020-01-25T14-03-12Z.sqlite';
    renameSync(path.join(dir, STORE_FILE), path.join(dir, aside));
    const fresh = launch().app;
    expect(fresh.read(1).items).toEqual([]);
    expect(fresh.conversations.files.setAside().map((entry) => entry.name)).toEqual([aside]);
    await fresh.quit();
    // The user puts it back.
    for (const file of storeFiles()) rmSync(path.join(dir, file), { force: true });
    renameSync(path.join(dir, aside), path.join(dir, STORE_FILE));
    expect(existsSync(path.join(dir, STORE_FILE))).toBe(true);
    expect(launch().app.texts(1)).toEqual([`user: ${PROMPT}`, 'assistant: Miso.']);
  });
});

describe('a removal killed after its mark (V24, V30; C63)', () => {
  /** A recorded chat whose removal was marked and then cut short, before the records write. */
  async function markedAndKilled(): Promise<void> {
    const { app, fake } = launch();
    await turn(app, fake);
    app.conversations.markRemoving([S(1)]);
    crash(app);
  }

  it('is finished at the next open: the record goes, then the rows, and the provider is asked nothing', async () => {
    await markedAndKilled();
    const { app, fake } = launch();
    // Under way from the open: not shown, and not counted as detached.
    expect(app.follower.detached()).toEqual([]);
    await until(() => app.conversations.conversation(S(1)) === null, 'the removal finishing');
    expect(app.service.snapshot().sessions).toEqual([]);
    expect(record()).toBeUndefined();
    expect(fake.made).toEqual([]);
    expect(fake.reads).toEqual([]);
  });

  it('deletes nothing while the records are refused, counts no detached chat, and finishes once Try again reads them', async () => {
    await markedAndKilled();
    const good = corrupt();
    const { app, fake } = launch();
    expect(app.records.isRefused()).toBe(true);
    expect(app.conversations.conversation(S(1))).toMatchObject({ removing: true });
    expect(app.conversations.newestPage(S(1)).items).toHaveLength(2);
    expect(app.follower.detached()).toEqual([]);

    writeFileSync(path.join(dir, RECORDS_FILE), good);
    expect(app.records.retry()).toEqual({ status: 'loaded' });
    // Listed for a moment, and neither reconciled nor checked: its removal is finished first.
    expect(app.runtime.kept(S(1))).toBeUndefined();
    expect(await app.runtime.send(S(1), 'hello')).toEqual({ status: 'refused', reason: 'busy' });
    await until(() => app.conversations.conversation(S(1)) === null, 'the removal finishing');
    // The record went first: the session is not listed again, and its history was never asked for.
    expect(app.service.snapshot().sessions).toEqual([]);
    expect(record()).toBeUndefined();
    expect(fake.reads).toEqual([]);
    expect(fake.made).toEqual([]);
  });

  it('keeps both when the record’s write fails there: the mark is lifted, and the session stays listed with its chat', async () => {
    await markedAndKilled();
    faults.records = () => true;
    const { app } = launch();
    await until(() => app.conversations.conversation(S(1))?.removing === false, 'the mark being lifted');
    expect(app.service.snapshot().sessions.map((entry) => entry.record.id)).toEqual([S(1)]);
    expect(app.texts(1)).toEqual([`user: ${PROMPT}`, 'assistant: Miso.']);
    expect(record()).toBeDefined();
  });
});
