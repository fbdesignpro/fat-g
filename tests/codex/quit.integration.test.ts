// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V40, V48, V52 (docs/planning/_archive/M15.md, Design 11; C117, C118) and V21, V23, V26 (M18.md; C45, C54,
// C59): the app's quit, as index.ts builds it with quitSteps, on the real Codex adapter and process
// layer against the replay fake. The order of the steps alone is in src/main/app/shutdown.test.ts.
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createShutdown, quitSteps } from '../../src/main/app/shutdown';
import { createConversationStore, type StoredTurn } from '../../src/main/conversations/store';
import { launchApp, placeRecords, QUIET, S, sessionEntry, storedSession } from '../sessions/app';
import { codexHarness, eventually, type Harness, PROMPTS } from './harness';

let harness: Harness | undefined;
afterEach(async () => { await harness?.dispose(); harness = undefined; });

function place(h: Harness, sessions: number[]): string {
  const dir = path.join(h.dir, 'records');
  placeRecords(dir, h.project, 'codex', sessions.map((n) => sessionEntry(n, 'codex', { model: 'gpt-6-astra' })));
  return dir;
}
const stored = (dir: string, n: number) => storedSession(dir, n);
/** The turn the store holds for a session after the quit, read as the next launch reads it. */
function storedTurn(dir: string, n: number): StoredTurn | null {
  const store = createConversationStore({ dir, log: QUIET });
  try {
    expect(store.status()).toEqual({ kind: 'ok' });
    return store.lastLocalTurn(S(n));
  } finally { store.close(); }
}

/** The app's session side and its quit, on the harness's adapter and process services. */
function app(h: Harness, dir: string, waits?: { stopMs?: number; writeMs?: number; killMs?: number }) {
  const launched = launchApp({ dir, descriptor: h.provider.descriptor, facet: () => h.facet, userDefault: () => 'ask-first' });
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
  return { records: launched.records, sessions: launched.service, runtime: launched.runtime, conversations: launched.conversations, shutdown, order, resumed, failure };
}

const running = (a: ReturnType<typeof app>, n: number) => a.sessions.isRunning(S(n));
const interrupts = (h: Harness) => Object.values(h.threads()).flatMap((thread) => thread.interrupts);
/** The processes the sessions ran on that are still there. */
const sessionPids = (h: Harness) => Object.values(h.threads()).flatMap((thread) => thread.launches.map((entry) => entry.pid)).filter((pid) => h.running().includes(pid));

describe('the quit (V40, V48)', () => {
  it('stops a running turn before any tree is ended: the turn keeps its own outcome, and every process is gone', async () => {
    const h = harness = await codexHarness();
    const dir = place(h, [1, 2]);
    const a = app(h, dir);
    expect(await a.runtime.send(S(1), PROMPTS.t4)).toEqual({ status: 'accepted' });
    expect(await a.runtime.send(S(2), PROMPTS.t1)).toEqual({ status: 'accepted' });
    await eventually(() => !running(a, 2), 15_000, 'the second session’s turn ending');
    await eventually(() => { const action = a.sessions.snapshot().sessions.find((entry) => entry.record.id === S(1))?.summary.action; return action != null && action.kind !== 'thinking'; }, 15_000, 'the first turn’s provider action');
    expect(sessionPids(h)).toHaveLength(2);

    a.shutdown.beforeQuit({ preventDefault() {} });
    // From the Stop on, no prompt is taken.
    await eventually(() => a.order.includes('closeAdmission'), 5000, 'the drain beginning');
    expect(await a.runtime.send(S(2), PROMPTS.t1)).toEqual({ status: 'refused', reason: 'busy' });
    expect(await a.shutdown.cleanup()).toEqual({ ok: true });
    await eventually(() => a.resumed.mock.calls.length === 1, 5000, 'the quit resuming');

    // The store is closed in the last step, once the runtimes have answered (M18, C45).
    expect(a.order).toEqual(['quiesce', 'closeAdmission', 'dispose', 'killAll', 'close store']);
    // The interrupt reached Codex while its input was still open, and the turn ended interrupted.
    expect(interrupts(h)).toEqual([{ inputOpen: true, worker: false }]);
    expect(stored(dir, 1)?.['lastTurn']).toMatchObject({ outcome: 'interrupted' });
    expect(stored(dir, 2)?.['lastTurn']).toMatchObject({ outcome: 'completed' });
    expect(a.failure).not.toHaveBeenCalled();
    // Both stores hold the same end of the same turn; Codex confirmed the interrupt, so the provider's end is its own.
    expect(storedTurn(dir, 1)).toMatchObject({ id: stored(dir, 1)?.['lastTurn'] === undefined ? '' : (stored(dir, 1)?.['lastTurn'] as { turnId: string }).turnId, sessionOutcome: 'interrupted', providerOutcome: 'interrupted' });
    expect(storedTurn(dir, 2)).toMatchObject({ sessionOutcome: 'completed', providerOutcome: 'completed' });
    // Closed cleanly: a write after it is a storage failure, and is not retried.
    expect(() => a.conversations.newestPage(S(1))).toThrow();
    await eventually(() => sessionPids(h).length === 0, 10_000, 'every session process ending');
  });

  it('writes a turn whose Stop Codex never confirms as stopped, then ends its tree all the same (V52)', async () => {
    const h = harness = await codexHarness();
    const dir = place(h, [1]);
    const a = app(h, dir, { stopMs: 300, writeMs: 300, killMs: 5000 });
    expect(await a.runtime.send(S(1), PROMPTS.t4)).toEqual({ status: 'accepted' });
    await eventually(() => { const action = a.sessions.snapshot().sessions.find((entry) => entry.record.id === S(1))?.summary.action; return action != null && action.kind !== 'thinking'; }, 15_000, 'the turn’s provider action');
    h.control({ hang: 'stop', turnNeverEnds: true });

    const started = Date.now();
    a.shutdown.beforeQuit({ preventDefault() {} });
    expect(await a.shutdown.cleanup()).toEqual({ ok: true });
    // The Stops had their time, then the write its own, and the trees were ended.
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(stored(dir, 1)?.['lastTurn']).toMatchObject({ outcome: 'stopped' });
    expect(a.order.slice(-3)).toEqual(['dispose', 'killAll', 'close store']);
    // The session's end is `stopped` in both stores, and the store holds no provider's end: the
    // `interrupted` the adapter gives as it is closed is no word of Codex's (M18, C45, C59).
    expect(storedTurn(dir, 1)).toMatchObject({ sessionOutcome: 'stopped', providerOutcome: null, endReceivedAt: null, providerTook: true });
    await eventually(() => sessionPids(h).length === 0, 10_000, 'the session process ending');
  });

  it('cancels a turn still starting: nothing more is sent, and its process goes with the rest', async () => {
    const h = harness = await codexHarness();
    const dir = place(h, [1]);
    const a = app(h, dir);
    h.control({ hang: 'open' });
    expect(await a.runtime.send(S(1), PROMPTS.t1)).toEqual({ status: 'accepted' });
    await eventually(() => h.pids().length >= 2, 10_000, 'the session process starting');
    a.shutdown.beforeQuit({ preventDefault() {} });
    expect(await a.shutdown.cleanup()).toEqual({ ok: true });
    expect(h.threads()).toEqual({});
    expect(running(a, 1)).toBe(false);
    // The prompt was recorded before anything was started, and Codex never took the turn: it reads
    // unacknowledged at the next launch, and nothing sends it again (M18, C15, C16).
    expect(storedTurn(dir, 1)).toMatchObject({ providerTook: false, providerOutcome: null, providerTurnId: null });
    await eventually(() => h.running().length === 0, 10_000, 'every process ending');
  });
});
