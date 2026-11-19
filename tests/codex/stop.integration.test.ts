// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V8, V58, V59 (docs/planning/_archive/M15.md; C27, C28, C131, C132): Stop, on the real adapter and process
// layer against the replay fake. The fake refuses an interrupt for a turn that has not started, as
// Codex was traced doing, so an interrupt sent too early shows as a turn that runs to its end.
// A Stop that Codex confirms ends the turn by Codex's word; one it never confirms ends it by the
// adapter's (docs/planning/_archive/M18.md, V26; C59).
import { afterEach, describe, expect, it } from 'vitest';
import { codexHarness, eventually, type Harness, PROMPTS, watch, STREAMED } from './harness';

let harness: Harness | undefined;
afterEach(async () => { await harness?.dispose(); harness = undefined; });
const start = (h: Harness) => watch(h.facet.start({ folder: h.project, model: 'gpt-6-astra', effort: 'low', speed: null, otherFolders: [], mode: 'read-only', processKey: 'process-1' }));
const interrupts = (h: Harness) => Object.values(h.threads()).flatMap((thread) => thread.interrupts);

describe('Stop (V8)', () => {
  it('interrupts a running turn, which ends interrupted; T4’s late item ends its own activity and changes nothing else (M20a, C6)', async () => {
    const h = harness = await codexHarness();
    const session = start(h);
    session.send(PROMPTS.t4);
    await session.until((event) => event.type === 'action-changed' && event.kind === 'reading');
    session.session.stop();
    // Codex confirmed the Stop with its own turn/completed: the end is reported (M18, C59).
    expect(await session.ended('turn-1')).toEqual({ type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: true });
    expect(interrupts(h)).toEqual([{ inputOpen: true, worker: false }]);
    // The read's completion comes after the turn's end: it still ends its item, and nothing follows it.
    const late = await session.until((event) => event.type === 'activity-ended');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(session.types().slice(-2)).toEqual(['turn-ended', 'activity-ended']);
    expect(late).toMatchObject({ turnId: 'turn-1', status: 'completed' });
    expect(session.events.filter((event) => event.type === 'activity-started').map((event) => event.type === 'activity-started' && event.itemId)).toEqual([late.type === 'activity-ended' ? late.itemId : null]);
    // Its process is still there, and takes the next prompt.
    session.send(PROMPTS.t1, 2);
    expect((await session.ended('turn-2')).outcome).toBe('completed');
    expect(Object.values(h.threads())[0]?.launches).toHaveLength(1);
  });

  it('pressed as the prompt is sent, waits for the turn to start: one interrupt, taken, and the turn ends interrupted (V58)', async () => {
    const h = harness = await codexHarness({ env: { FATG_SMOKE_CODEX_GAP_MS: '20' } });
    const session = start(h);
    session.send(PROMPTS.t1);
    // Once the thread has been started the prompt is on its way: the Stop comes before the turn has.
    await eventually(() => Object.keys(h.threads()).length === 1, 5000, 'the thread starting');
    await new Promise((resolve) => setTimeout(resolve, 5));
    session.session.stop();
    const end = await session.ended('turn-1');
    // An interrupt sent at the reply would have been refused, and the turn would have completed.
    expect(end.outcome).toBe('interrupted');
    expect(interrupts(h).length).toBeLessThanOrEqual(1);
    expect(session.notices()).toEqual([]);
  });

  it('cancels a start before the prompt is sent: nothing more is sent, and the process is closed', async () => {
    const h = harness = await codexHarness();
    h.control({ hang: 'open' });
    const session = start(h);
    session.send(PROMPTS.t1);
    await eventually(() => h.pids().length === 2, 5000, 'the session process starting');
    session.session.stop();
    expect((await session.ended('turn-1')).outcome).toBe('interrupted');
    await expect(session.session.closed).resolves.toEqual({ ok: true });
    expect(interrupts(h)).toEqual([]);
    expect(h.threads()).toEqual({});
    await eventually(() => h.running().length === 1, 5000, 'the session process ending');
  });

  it.each([['Codex does not answer', { hang: 'stop', turnNeverEnds: true }], ['Codex refuses the interrupt', { refuseInterrupt: true, turnNeverEnds: true }]])(
    'ends the session’s process when the Stop is not confirmed in time (%s), the other sessions untouched', async (_name, control) => {
      const h = harness = await codexHarness({ timings: { stopMs: 400 } });
      const other = start(h);
      other.send(PROMPTS.t4);
      await other.until((event) => event.type === 'action-changed' && event.kind === 'reading');

      h.control(control);
      const session = start(h);
      session.send(PROMPTS.t1);
      await session.until((event) => event.type === 'message' && event.phase === 'final');
      const pid = Object.values(h.threads()).find((thread) => thread.turns[0] === STREAMED.t1)?.launches[0]?.pid;
      expect(typeof pid).toBe('number');
      session.session.stop();
      // The adapter's own end: Codex never said the turn was over (M18, C59).
      expect(await session.ended('turn-1')).toEqual({ type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: false });
      expect(session.notices()).toEqual(['stop-unconfirmed']);
      await expect(session.session.closed).resolves.toEqual({ ok: true });
      expect(h.running()).not.toContain(pid);

      // The other session's turn is still its own to stop.
      h.control({});
      expect(other.types()).not.toContain('turn-ended');
      other.session.stop();
      expect((await other.ended('turn-1')).outcome).toBe('interrupted');
    });
});

describe('Stop with a worker open (V59; C132)', () => {
  it('interrupts the session’s turn and the worker’s own, and ends the worker as failed before the turn', async () => {
    const h = harness = await codexHarness();
    const session = start(h);
    session.send(PROMPTS.workerInterrupt);
    await session.until((event) => event.type === 'worker-started');
    // The capture shows fat-g sending both interrupts, the session's and the worker's own, so the
    // replay waits there, after the worker's turn/started: by now it has arrived.
    await new Promise((resolve) => setTimeout(resolve, 500));
    session.session.stop();
    expect((await session.ended('turn-1')).outcome).toBe('interrupted');
    const types = session.types();
    expect(types.indexOf('worker-ended')).toBeGreaterThan(-1);
    expect(types.indexOf('worker-ended')).toBeLessThan(types.indexOf('turn-ended'));
    expect(session.events.find((event) => event.type === 'worker-ended')).toMatchObject({ outcome: 'failed' });
    await eventually(() => interrupts(h).length === 2, 5000, 'both interrupts arriving');
    expect(interrupts(h)).toEqual(expect.arrayContaining([{ inputOpen: true, worker: false }, { inputOpen: true, worker: true }]));
  });
});
