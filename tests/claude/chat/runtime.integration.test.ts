// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V14 (docs/planning/_archive/M16.md; C42, C44–C46, C71): the session runtime on the real Claude adapter and
// process layer, against the replay fake. The records store, the conversation store, the session
// service, the gate and the chat service are the app's own; only Electron is absent. What M15 built
// for Codex — the idle close, a removal, the quit's order and waits, the guard on Settings' actions,
// the hold of a session whose end could not be confirmed — holds with Claude's fake, unchanged.
//
// The gate's rows are in gate.integration.test.ts, the store's contract in store.integration.test.ts,
// the reference in reference.integration.test.ts and the other roots in roots.integration.test.ts.
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { noticeWords } from '@shared/contracts/chat';
import { type ConversationItem, itemText } from '@shared/contracts/conversation';
import type { AgentProvider } from '@shared/provider-kit/provider';
import type { SessionFacet } from '@shared/provider-kit/sessions';
import type * as TreeKill from '../../../src/main/process/tree-kill';
import { createShutdown, quitSteps } from '../../../src/main/app/shutdown';
import { createConversationStore, type StoredTurn } from '../../../src/main/conversations/store';
import { writeFileAtomic } from '../../../src/main/storage/atomic-write';
import { type App, type AppOptions, launchApp, placeRecords, QUIET, S, sessionEntry, storedSession, until } from '../../sessions/app';

// Lets a test make a tree's forced end fail on purpose, as tests/process/managed-cleanup.test.ts does.
const control = vi.hoisted(() => ({ failCleanup: false }));
vi.mock('../../../src/main/process/tree-kill', async (importOriginal) => {
  const actual = await importOriginal<typeof TreeKill>();
  return { ...actual, terminateTree: (...args: Parameters<typeof actual.terminateTree>) => (control.failCleanup ? Promise.resolve({ ok: false }) : actual.terminateTree(...args)) };
});
const { claudeHarness } = await import('./harness');
type Harness = Awaited<ReturnType<typeof claudeHarness>>;

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

let harness: Harness | undefined;
let apps: App[] = [];
afterEach(async () => {
  control.failCleanup = false;
  for (const app of apps) await app.quit();
  apps = [];
  await harness?.dispose();
  harness = undefined;
  vi.clearAllMocks();
});

const dataDir = (h: Harness): string => path.join(h.dir, 'records');
const place = (h: Harness, sessions: readonly number[] = [1]): void => placeRecords(dataDir(h), h.project, 'claude', sessions.map((n) => sessionEntry(n, 'claude', { model: 'sonnet' })));
const stored = (h: Harness, n = 1) => storedSession(dataDir(h), n);
function launch(h: Harness, options: Partial<AppOptions> = {}): App {
  const app = launchApp({ dir: dataDir(h), descriptor: h.provider.descriptor, facet: () => h.facet, log, ...options });
  apps.push(app);
  return app;
}
const idle = (app: App, n = 1) => until(() => !app.service.isRunning(S(n)), 'the session coming to rest', 20_000);
async function turn(app: App, prompt: string, n = 1): Promise<void> {
  expect(await app.runtime.send(S(n), prompt)).toEqual({ status: 'accepted' });
  await idle(app, n);
  await app.service.settled();
}
/** Ends a run as the app's quit does, with its adapter, and answers the next run's. */
async function restart(h: Harness, app: App, provider: AgentProvider = h.provider): Promise<{ provider: AgentProvider; facet: SessionFacet }> {
  apps = apps.filter((candidate) => candidate !== app);
  await app.quit();
  await provider.dispose();
  await until(() => h.running('chat').length === 0, 'the session’s process ending', 15_000);
  return h.adapter();
}
const shape = (items: readonly ConversationItem[]) => items.map((item) => (item.kind === 'activity' ? `activity:${item.activity?.type}` : item.role === 'assistant' ? `assistant:${item.phase}` : item.role ?? item.notice));
const notices = (app: App, n = 1) => app.read(n).items.flatMap((item) => (item.notice === null || item.notice === undefined ? [] : [item.notice]));
const acting = (app: App, n = 1) => until(() => { const action = app.summary(n)?.action; return action != null && action.kind !== 'thinking'; }, 'the turn’s first provider action', 15_000);

describe('a prompt, from the composer to the record (V14; C42, C44)', () => {
  it('starts the session in its project’s folder, shows the answer, stores the reference, and sends the next prompt on the same process', async () => {
    const h = harness = await claudeHarness();
    place(h);
    const app = launch(h);
    expect(app.service.blockOf(S(1))).toBeNull();

    expect(await app.runtime.send(S(1), h.prompts.t3)).toEqual({ status: 'accepted' });
    // Running from the acceptance, before any process has answered.
    expect(app.summary(1)?.status).toBe('running');
    await idle(app);
    await app.service.settled();

    const { id } = h.only();
    const record = stored(h);
    expect(record).toMatchObject({ reference: id, folder: h.project, nameSource: 'first-message', lastTurn: { outcome: 'completed' } });
    expect(app.summary(1)).toMatchObject({ status: 'idle', attention: { kind: 'ready' } });
    const first = app.read(1);
    // The commentary came before the worker, whose start is the session's own item (M20a, C21), and the
    // last text was named the answer by the turn's end (C74). What the worker did is its own, and not here (C22).
    expect(shape(first.items)).toEqual(['user', 'assistant:commentary', 'activity:worker', 'assistant:final']);
    expect(first.items.every((item) => item.workerId === null)).toBe(true);
    expect(first.items[0]?.blocks[0]?.text).toBe(h.prompts.t3);
    // Claude has no history to read back: nothing is checked, and nothing is asked of the facet (C49).
    expect(first.history).toMatchObject({ olderUnread: false, earlierMissing: false });
    expect(h.only().entry).toMatchObject({ cwd: h.project, turns: ['m19-t3-subagent'] });
    expect(app.conversations.conversation(S(1))).toMatchObject({ reference: id, folder: h.project });

    await turn(app, h.prompts.t1);
    expect(h.only().entry.turns).toEqual(['m19-t3-subagent', 'm19-t1-basic']);
    expect(h.only().entry.launches).toHaveLength(1);
    expect(app.read(1).items.filter((item) => item.role === 'user').map((item) => item.blocks[0]?.text)).toEqual([h.prompts.t3, h.prompts.t1]);
    // The name came from the first prompt, and stays.
    expect(stored(h)?.['name']).toBe(record?.['name']);
    // Nothing of the conversation is in the log, and no session id of Claude's.
    const logged = JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls]);
    expect(logged).not.toContain(h.prompts.t3.slice(0, 24));
    expect(logged).not.toContain(id);
    expect(h.markers()).toEqual([]);
  });

  it('shows a failed turn as ERROR with its notice and the CLI’s own words, and the next turn as READY', async () => {
    const h = harness = await claudeHarness();
    place(h);
    const app = launch(h);
    await turn(app, h.prompts.t5);
    expect(app.summary(1)?.attention).toMatchObject({ kind: 'error' });
    const notice = app.read(1).items.find((item) => item.kind === 'notice');
    expect(notice).toMatchObject({ notice: 'turn-failed', role: null });
    expect(typeof notice?.detail).toBe('string');
    expect(stored(h)).toMatchObject({ lastTurn: { outcome: 'failed' } });
    await turn(app, h.prompts.t1);
    expect(app.summary(1)?.attention).toMatchObject({ kind: 'ready' });
    expect(app.read(1).turns.map((entry) => entry.outcome)).toEqual(['failed', 'completed']);
    expect(h.only().entry.launches).toHaveLength(1);
  });
});

describe('Stop, from the composer (V14; C28)', () => {
  it('interrupts the turn: its record says interrupted, the session reads READY, and its process takes the next prompt', async () => {
    const h = harness = await claudeHarness();
    place(h);
    const app = launch(h);
    expect(app.runtime.stop(S(1))).toEqual({ status: 'refused', reason: 'not-running' });
    expect(await app.runtime.send(S(1), h.prompts.t4)).toEqual({ status: 'accepted' });
    await acting(app);
    expect(app.runtime.stop(S(1))).toEqual({ status: 'stopping' });
    await idle(app);
    await app.service.settled();
    expect(app.summary(1)).toMatchObject({ status: 'idle', attention: { kind: 'ready' } });
    expect(stored(h)?.['lastTurn']).toMatchObject({ outcome: 'interrupted' });
    expect(h.only().entry.interrupts).toHaveLength(1);
    // The CLI confirmed the interrupt: the end is its own, and the turn reads ended.
    expect(app.read(1).turns[0]).toMatchObject({ state: 'ended', outcome: 'interrupted' });
    // The interrupt's marker is no message.
    expect(shape(app.read(1).items)).not.toContain('assistant:final');

    await turn(app, h.prompts.t1);
    expect(h.only().entry.launches).toHaveLength(1);
    expect(stored(h)?.['lastTurn']).toMatchObject({ outcome: 'completed' });
  });
});

describe('a later run (V14; C45, C50)', () => {
  it('keeps the saved chat readable when Claude does not reopen the conversation, and says so beside it', async () => {
    const h = harness = await claudeHarness();
    place(h);
    const before = launch(h);
    await turn(before, h.prompts.t1);
    const live = before.read(1).items;
    const next = await restart(h, before);

    const app = launch(h, { facet: () => next.facet });
    expect(app.read(1).items).toEqual(live);
    // The conversation is gone from Claude's own history, as one removed there would be.
    h.control({ resumeMissing: 1 });
    await turn(app, h.prompts.t1);
    const after = app.read(1).items;
    // Everything recorded is still read; the refusal is a line after it, and the prompt is shown once.
    expect(after.slice(0, live.length)).toEqual(live);
    const notice = after.find((item) => item.notice === 'session-not-reopened');
    expect(itemText(notice as ConversationItem)).toBe(noticeWords('session-not-reopened', 'Claude'));
    expect(itemText(notice as ConversationItem)).toContain('The chat fat-g saved stays readable.');
    expect(after.filter((item) => item.role === 'user')).toHaveLength(2);
    expect(app.summary(1)?.attention).toMatchObject({ kind: 'error' });
    // The reference is kept: nothing said the conversation is gone for good, and the next prompt reopens it.
    expect(stored(h)?.['reference']).toBe(h.only().id);
    await turn(app, h.prompts.t1);
    expect(h.only().entry.turns).toEqual(['m19-t1-basic', 'm19-t1-basic']);
    expect(app.summary(1)?.attention).toMatchObject({ kind: 'ready' });
  });
});

describe('a session’s process, when it is no longer needed (V14; C45)', () => {
  it('is closed once the session has been idle for its time, and the next prompt resumes the conversation in a new one', async () => {
    const h = harness = await claudeHarness();
    place(h);
    const app = launch(h, { idleMs: 200 });
    await turn(app, h.prompts.t1);
    const [first] = h.only().entry.launches;
    await until(() => h.running('chat').length === 0, 'the idle process closing', 15_000);
    // Closed, and nothing about the session changed: it reads as it did, and takes a prompt.
    expect(app.summary(1)).toMatchObject({ status: 'idle', attention: { kind: 'ready' } });
    expect(notices(app)).toEqual([]);

    await turn(app, h.prompts.t1);
    const { id, entry } = h.only();
    expect(entry.launches).toHaveLength(2);
    expect(entry.launches[1]).toMatchObject({ resume: id });
    expect(entry.launches[1]?.pid).not.toBe(first?.pid);
    expect(entry.turns).toHaveLength(2);
  });

  it('is not closed while a turn runs, however long the turn', async () => {
    const h = harness = await claudeHarness();
    place(h);
    const app = launch(h, { idleMs: 100 });
    expect(await app.runtime.send(S(1), h.prompts.t4)).toEqual({ status: 'accepted' });
    await acting(app);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(h.running('chat')).toHaveLength(1);
    expect(app.service.isRunning(S(1))).toBe(true);
    expect(app.runtime.stop(S(1))).toEqual({ status: 'stopping' });
    await idle(app);
  });

  it('is closed when its record is removed, and nothing of it is read after', async () => {
    const h = harness = await claudeHarness();
    place(h, [1, 2]);
    const app = launch(h);
    await turn(app, h.prompts.t1, 1);
    await turn(app, h.prompts.t1, 2);
    expect(h.running('chat')).toHaveLength(2);

    // As the Main window's Remove does it: the chat goes with the record.
    expect(await app.removal.run([S(1)], () => app.service.remove(S(1)), (answer) => answer.status === 'saved')).toMatchObject({ status: 'saved' });
    await until(() => h.running('chat').length === 1, 'the removed session’s process ending', 15_000);
    expect(app.runtime.read(S(1))).toEqual({ status: 'refused', reason: 'unknown-session' });
    expect(app.conversations.conversation(S(1))).toBeNull();
    // Nothing of Claude's is deleted: both conversations are still its own.
    expect(Object.keys(h.sessions())).toHaveLength(2);
    // The other session is untouched: same process, and it takes a prompt.
    await turn(app, h.prompts.t1, 2);
    expect(h.running('chat')).toHaveLength(1);
    expect(Object.values(h.sessions()).map((entry) => entry.launches.length)).toEqual([1, 1]);
  });
});

describe('the reference, when the record’s write fails (V14; C44)', () => {
  it('is kept for the run and in the conversation store: the chat says so once, and the next launch resumes by it', async () => {
    const h = harness = await claudeHarness();
    place(h);
    // Every write that would save a reference fails; the others go to disk as they do.
    const app = launch(h, { idleMs: 200, records: { write: (target, text) => (/"reference":\s*"/.test(text) ? Promise.reject(Object.assign(new Error('disk'), { code: 'EIO' })) : writeFileAtomic(target, text)) } });
    expect(await app.runtime.send(S(1), h.prompts.t1)).toEqual({ status: 'accepted' });
    await idle(app);
    await app.service.settled();
    const { id } = h.only();
    // Not in the file; kept beside the record for the run, and in the store with its folder.
    expect(stored(h)?.['reference']).toBeNull();
    expect(app.runtime.kept(S(1))).toEqual({ reference: id, folder: h.project });
    expect(app.conversations.conversation(S(1))).toMatchObject({ reference: id, folder: h.project });
    expect(notices(app).filter((notice) => notice === 'session-unsaved')).toHaveLength(1);
    // The turn itself is the conversation's, and reads as it ended.
    expect(app.read(1).turns[0]).toMatchObject({ state: 'ended', outcome: 'completed' });

    // The process closes; the next prompt reopens the same conversation, and starts no second one.
    await until(() => h.running('chat').length === 0, 'the idle process closing', 15_000);
    expect(await app.runtime.send(S(1), h.prompts.t1)).toEqual({ status: 'accepted' });
    await idle(app);
    await app.service.settled();
    expect(Object.keys(h.sessions())).toEqual([id]);
    expect(h.only().entry.launches[1]).toMatchObject({ resume: id });
    expect(notices(app).filter((notice) => notice === 'session-unsaved')).toHaveLength(1);
  });
});

describe('a session whose process’s end could not be confirmed (V14; C71)', () => {
  it('is held alone: its own next prompt is refused, while another session of the instance and a usage read go on, until its tree is seen gone', async () => {
    // Each chat process starts a child that outlives it and keeps its output open: the tree cannot
    // be seen gone until that child ends.
    const h = harness = await claudeHarness({ env: { FATG_SMOKE_CLAUDE_DESCENDANT: 'hold' } });
    place(h, [1, 2]);
    const app = launch(h, { idleMs: 200 });
    control.failCleanup = true;
    await turn(app, h.prompts.t1, 1);
    // The idle close ends the process, and its tree's end is not confirmed.
    await until(() => log.info.mock.calls.some(([line]) => String(line).includes('session end unconfirmed')), 'the unconfirmed end', 20_000);
    control.failCleanup = false;
    const [held] = h.pids('chat-descendant');
    expect(await app.runtime.send(S(1), h.prompts.t1)).toEqual({ status: 'refused', reason: 'unconfirmed' });
    expect(h.only().entry.launches).toHaveLength(1);

    // The instance's scope is open to launches: its other session runs a turn, and its usage is read.
    await turn(app, h.prompts.t1, 2);
    expect(app.summary(2)).toMatchObject({ status: 'idle', attention: { kind: 'ready' } });
    expect(await h.provider.getUsage(new AbortController().signal)).toMatchObject({ kind: 'usage' });
    expect(await app.runtime.send(S(1), h.prompts.t1)).toEqual({ status: 'refused', reason: 'unconfirmed' });

    // The tree ends late, outside fat-g's cleanup: the session's own next Send looks, and goes on.
    // SIGKILL: that child ignores SIGTERM, as the fake's `hold` mode has it, and only on Windows
    // does a plain kill end it all the same.
    process.kill(held as number, 'SIGKILL');
    const deadline = Date.now() + 15_000;
    let answer = await app.runtime.send(S(1), h.prompts.t1);
    while (answer.status !== 'accepted' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      answer = await app.runtime.send(S(1), h.prompts.t1);
    }
    expect(answer).toEqual({ status: 'accepted' });
    await idle(app, 1);
    const first = Object.values(h.sessions()).find((entry) => entry.launches.length === 2);
    expect(first?.launches[1]?.resume).not.toBeNull();
    expect(first?.turns).toHaveLength(2);
  });
});

describe('the guard on Settings’ actions (V14; C45)', () => {
  it('reads a Claude session as running on its instance from the acceptance to the turn’s end, and on no other', async () => {
    const h = harness = await claudeHarness();
    place(h);
    const app = launch(h);
    const first = { providerId: 'claude', instanceId: 'default' };
    expect(app.runtime.runningOn(first)).toBe(false);
    expect(await app.runtime.send(S(1), h.prompts.t4)).toEqual({ status: 'accepted' });
    await acting(app);
    expect(app.runtime.runningOn(first)).toBe(true);
    expect(app.runtime.runningOn({ providerId: 'claude', instanceId: '0b6f2c1e-5a4d-4e0b-9a51-7f3d1c0e6b19' })).toBe(false);
    expect(app.runtime.runningOn({ providerId: 'codex', instanceId: 'default' })).toBe(false);
    expect(app.runtime.stop(S(1))).toEqual({ status: 'stopping' });
    await idle(app);
    // Its process is still there, idle: an action on the instance is no longer held back.
    expect(h.running('chat')).toHaveLength(1);
    expect(app.runtime.runningOn(first)).toBe(false);
  });
});

describe('the quit (V14; C45, C46)', () => {
  /** The turn the store holds for a session after the quit, read as the next launch reads it. */
  function storedTurn(h: Harness, n: number): StoredTurn | null {
    const store = createConversationStore({ dir: dataDir(h), log: QUIET });
    try {
      expect(store.status()).toEqual({ kind: 'ok' });
      return store.lastLocalTurn(S(n));
    } finally { store.close(); }
  }
  /** The app's session side and its quit, on the harness's adapter and process services. */
  function quitting(h: Harness, waits?: { stopMs?: number; writeMs?: number; killMs?: number }) {
    const launched = launchApp({ dir: dataDir(h), descriptor: h.provider.descriptor, facet: () => h.facet });
    const order: string[] = [];
    const resumed = vi.fn();
    const failure = vi.fn();
    const shutdown = createShutdown(quitSteps({
      providers: { quiesce: () => { order.push('quiesce'); }, dispose: async () => { order.push('dispose'); await h.provider.dispose(); } },
      runtime: launched.runtime, sessions: launched.service,
      processes: { closeAdmission: () => { order.push('closeAdmission'); h.services.closeAdmission(); }, killAll: () => { order.push('killAll'); return h.services.killAll(); }, emergency: () => h.services.emergency() },
      conversations: { close: () => { order.push('close store'); launched.conversations.close(); } },
      windows: { beginQuit: () => undefined },
      resumeQuit: resumed, failure,
      ...(waits === undefined ? {} : { waits }),
    }));
    return { app: launched, shutdown, order, resumed, failure };
  }

  it('stops a running turn before any tree is ended: the turn keeps the CLI’s own outcome, and every process is gone', async () => {
    const h = harness = await claudeHarness();
    place(h, [1, 2]);
    const a = quitting(h);
    expect(await a.app.runtime.send(S(1), h.prompts.t4)).toEqual({ status: 'accepted' });
    await turn(a.app, h.prompts.t1, 2);
    await acting(a.app, 1);
    expect(h.running('chat')).toHaveLength(2);

    a.shutdown.beforeQuit({ preventDefault() {} });
    // From the Stop on, no prompt is taken.
    await until(() => a.order.includes('closeAdmission'), 'the drain beginning', 5000);
    expect(await a.app.runtime.send(S(2), h.prompts.t1)).toEqual({ status: 'refused', reason: 'busy' });
    expect(await a.shutdown.cleanup()).toEqual({ ok: true });
    await until(() => a.resumed.mock.calls.length === 1, 'the quit resuming', 5000);

    // The store is closed in the last step, once the runtimes have answered.
    expect(a.order).toEqual(['quiesce', 'closeAdmission', 'dispose', 'killAll', 'close store']);
    // The interrupt reached the CLI while its input was still open, and the turn ended interrupted.
    expect(Object.values(h.sessions()).flatMap((entry) => entry.interrupts)).toEqual([{ inputOpen: true, turn: true, workers: 0 }]);
    expect(stored(h, 1)?.['lastTurn']).toMatchObject({ outcome: 'interrupted' });
    expect(stored(h, 2)?.['lastTurn']).toMatchObject({ outcome: 'completed' });
    expect(a.failure).not.toHaveBeenCalled();
    // Both stores hold the same end of the same turn, and the provider's end is the CLI's own.
    expect(storedTurn(h, 1)).toMatchObject({ id: (stored(h, 1)?.['lastTurn'] as { turnId: string }).turnId, sessionOutcome: 'interrupted', providerOutcome: 'interrupted' });
    expect(storedTurn(h, 2)).toMatchObject({ sessionOutcome: 'completed', providerOutcome: 'completed' });
    await until(() => h.running('chat').length === 0, 'every session process ending', 15_000);
  });

  it('writes a turn whose Stop the CLI never confirms as stopped, then ends its tree all the same', async () => {
    const h = harness = await claudeHarness();
    place(h);
    const a = quitting(h, { stopMs: 300, writeMs: 300, killMs: 5000 });
    expect(await a.app.runtime.send(S(1), h.prompts.t4)).toEqual({ status: 'accepted' });
    await acting(a.app);
    h.control({ hang: 'stop' });

    const started = Date.now();
    a.shutdown.beforeQuit({ preventDefault() {} });
    expect(await a.shutdown.cleanup()).toEqual({ ok: true });
    // The Stops had their time, then the write its own, and the trees were ended.
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(stored(h)?.['lastTurn']).toMatchObject({ outcome: 'stopped' });
    expect(a.order.slice(-3)).toEqual(['dispose', 'killAll', 'close store']);
    // The session's end is `stopped` in both stores, and the store holds no provider's end: what
    // the adapter says as it is closed is no word of the CLI's.
    expect(storedTurn(h, 1)).toMatchObject({ sessionOutcome: 'stopped', providerOutcome: null, endReceivedAt: null, providerTook: true });
    await until(() => h.running('chat').length === 0, 'the session process ending', 15_000);
  });

  it('cancels a turn still starting: no prompt is written, and its process goes with the rest', async () => {
    const h = harness = await claudeHarness();
    place(h);
    const a = quitting(h);
    h.control({ hang: 'initialize' });
    expect(await a.app.runtime.send(S(1), h.prompts.t1)).toEqual({ status: 'accepted' });
    // Started, and its session written down: the fake records its process first, then its session.
    await until(() => h.pids('chat').length === 1 && Object.keys(h.sessions()).length === 1, 'the session process starting', 15_000);
    a.shutdown.beforeQuit({ preventDefault() {} });
    expect(await a.shutdown.cleanup()).toEqual({ ok: true });
    expect(h.only().entry).toMatchObject({ kept: false, turns: [] });
    expect(a.app.service.isRunning(S(1))).toBe(false);
    // The prompt was recorded before anything was started, and Claude never took the turn: it reads
    // unacknowledged at the next launch, and nothing sends it again.
    expect(storedTurn(h, 1)).toMatchObject({ providerTook: false, providerOutcome: null, providerTurnId: null });
    expect(stored(h)?.['reference']).toBeNull();
    await until(() => h.running().length === 0, 'every process ending', 15_000);
    expect(h.markers()).toEqual([]);
  });
});
