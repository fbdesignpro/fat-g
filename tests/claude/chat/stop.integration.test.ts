// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V11, V13 (docs/planning/_archive/M16.md; C28–C30, C39, C40): Stop and losses, on the real adapter and process
// layer against the replay fake. A Stop in each state of a turn, a Stop the CLI never confirms, the
// workers left after a turn, and a process that ends where it should not.
import { afterEach, describe, expect, it } from 'vitest';
import { claudeHarness, eventually, type Harness, type HarnessOptions, processGone, READING, watch } from './harness';

let harness: Harness | undefined;
afterEach(async () => { await harness?.dispose(); harness = undefined; });
const open = async (options?: HarnessOptions): Promise<Harness> => (harness = await claudeHarness(options));
const start = (h: Harness) => watch(h.facet.start({ folder: h.project, model: 'sonnet', effort: 'low', speed: null, otherFolders: [], ...READING }));

describe('Stop (V11; C28)', () => {
  it('interrupts a running turn, which ends interrupted by the CLI’s own word; the next prompt runs on the same process', async () => {
    const h = await open();
    const s = start(h);
    s.send(h.prompts.t4);
    // K2's T4 was interrupted while its last text was being written: the replay waits there for its interrupt.
    await s.until((event) => event.type === 'message-delta' && event.text !== '');
    expect(s.events.some((event) => event.type === 'message')).toBe(false);
    s.session.stop();
    expect(await s.ended('turn-1')).toEqual({ type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: true });
    expect(h.only().entry.interrupts).toEqual([{ inputOpen: true, turn: true, workers: 0 }]);
    // The CLI sends the frame with what it had written. It does not complete the message (M19, C80): the
    // text is left as it was received, for the chat to keep as unfinished, with no phase said. The
    // interrupt's marker is no message, and no notice is shown for a Stop the CLI confirmed.
    const written = s.events.flatMap((event) => (event.type === 'message-delta' ? [event] : []));
    expect(written.map((delta) => delta.text).join('')).toBe('Summ');
    expect(s.events.some((event) => event.type === 'message')).toBe(false);
    expect(s.events.some((event) => event.type === 'notice')).toBe(false);
    s.send(h.prompts.t1, 2);
    expect(await s.ended('turn-2')).toMatchObject({ outcome: 'completed', reported: true });
    expect(h.only().entry.launches).toHaveLength(1);
  });

  it('pressed between the prompt and its `init`, sends `interrupt` at once: the turn, replayed from K22, ends interrupted with no message', async () => {
    const h = await open();
    const s = start(h);
    s.send(h.prompts.early);
    // The fake has the prompt, and sends nothing of the turn until the interrupt comes (K22).
    await eventually(() => Object.values(h.sessions()).some((entry) => entry.turns.length === 1), 10_000, 'the prompt reaching the fake');
    expect(s.events).toEqual([]);
    s.session.stop();
    expect(await s.ended('turn-1')).toEqual({ type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: true });
    // Claude took the prompt before it was interrupted: the turn's start is said, and no model answered.
    expect(s.types()).toEqual(['turn-started', 'in-force', 'turn-ended']);
    expect(s.reference()).toBeUndefined();
    expect(h.only().entry.interrupts).toHaveLength(1);
  });

  it('cancels a start before the prompt is written: the fake is given no prompt, and the process is closed', async () => {
    const h = await open();
    h.control({ hang: 'initialize' });
    const s = start(h);
    s.send(h.prompts.t1);
    // Started, and its session written down: the fake records its process first, then its session,
    // and a Stop that comes between the two would end it with nothing to read back.
    await eventually(() => h.pids('chat').length === 1 && Object.keys(h.sessions()).length === 1, 10_000, 'the process starting');
    s.session.stop();
    expect(await s.ended('turn-1')).toEqual({ type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: false });
    await processGone(h, s.session);
    expect(h.only().entry).toMatchObject({ kept: false, turns: [], interrupts: [] });
    expect(s.notices()).toEqual([]);
  });

  it('ends the process 10 seconds — here, a moment — after a Stop the CLI does not confirm', async () => {
    const h = await open({ timings: { stopMs: 400 } });
    h.control({ hang: 'stop' });
    const s = start(h);
    s.send(h.prompts.t4);
    await s.until((event) => event.type === 'action-changed');
    s.session.stop();
    expect(await s.ended('turn-1')).toEqual({ type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: false });
    expect(s.notices()).toEqual(['stop-unconfirmed']);
    await processGone(h, s.session);
    // The interrupt arrived once, with the input still open.
    expect(h.only().entry.interrupts).toEqual([{ inputOpen: true, turn: true, workers: 0 }]);
  });

  it('ends the workers left running after their turn at once, with their notice and no interrupt (K17)', async () => {
    const h = await open();
    const s = start(h);
    s.send(h.prompts.self);
    expect(await s.ended('turn-1')).toMatchObject({ outcome: 'completed', reported: true });
    // The turn ended with its worker still running: the replay now waits for a prompt.
    expect(s.events.filter((event) => event.type === 'worker-started')).toHaveLength(1);
    expect(s.events.some((event) => event.type === 'worker-ended')).toBe(false);
    s.session.stop();
    await s.until((event) => event.type === 'notice' && event.kind === 'workers-stopped');
    expect(s.events.slice(-2).map((event) => event.type)).toEqual(['worker-ended', 'notice']);
    expect(s.events.at(-2)).toMatchObject({ outcome: 'failed' });
    await processGone(h, s.session);
    expect(h.only().entry.interrupts).toEqual([]);
  });

  it('writes no second prompt while a turn runs (C30)', async () => {
    const h = await open();
    const s = start(h);
    s.send(h.prompts.t4, 1);
    await s.until((event) => event.type === 'action-changed');
    s.send(h.prompts.t1, 2);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(h.only().entry.turns).toEqual(['m19-t4-interrupt']);
    expect(s.events.some((event) => 'turnId' in event && event.turnId === 'turn-2')).toBe(false);
    s.session.stop();
    await s.ended('turn-1');
  });
});

describe('a worker at a Stop (V13; C39, C40)', () => {
  it('closes by the CLI’s two frames before the turn’s own end, once and as failed', async () => {
    // The replay's gaps are the capture's own up to 300 ms here, and not the harness's 1 ms: the worker's
    // closing frames come two seconds after its progress in the capture, so the Stop, pressed on seeing
    // that progress, reaches the fake long before the replay would send them itself.
    const h = await open({ env: { FATG_SMOKE_CLAUDE_GAP_MS: '300' } });
    h.control({ holdResult: 20_000, workerNoClose: true });
    const s = start(h);
    s.send(h.prompts.t3);
    await s.until((event) => event.type === 'worker-progressed', 20_000);
    h.control({});
    s.session.stop();
    expect(await s.ended('turn-1')).toEqual({ type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: true });
    const ends = s.events.filter((event) => event.type === 'worker-ended');
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ outcome: 'failed' });
    expect(s.types().indexOf('worker-ended')).toBeLessThan(s.types().indexOf('turn-ended'));
    expect(h.only().entry.interrupts).toEqual([{ inputOpen: true, turn: true, workers: 1 }]);
  });

  it('is ended as failed first when a Stop goes unconfirmed, and when its closing frames never come', async () => {
    const h = await open({ timings: { stopMs: 400 } });
    h.control({ hang: 'stop', workerNoClose: true, holdResult: 20_000 });
    const s = start(h);
    s.send(h.prompts.t3);
    await s.until((event) => event.type === 'worker-started');
    s.session.stop();
    await s.ended('turn-1');
    expect(s.events.slice(-3).map((event) => (event.type === 'notice' ? `notice:${event.kind}` : event.type))).toEqual(['worker-ended', 'notice:stop-unconfirmed', 'turn-ended']);
    expect(s.events.at(-3)).toMatchObject({ outcome: 'failed' });
    await processGone(h, s.session);
  });

  it('launches every session with background tasks off, so a worker ends with its turn (C40)', async () => {
    const h = await open();
    const s = start(h);
    s.send(h.prompts.t3);
    expect(await s.ended('turn-1')).toMatchObject({ outcome: 'completed' });
    expect(h.env('chat', h.pids('chat')[0] as number).values['CLAUDE_CODE_DISABLE_BACKGROUND_TASKS']).toBe('1');
    // T3's worker ran in the foreground: opened and ended inside the turn.
    expect(s.types().indexOf('worker-ended')).toBeLessThan(s.types().indexOf('turn-ended'));
  });
});

describe('a process that ends (V11; C29, C76)', () => {
  it('during a turn: the turn ends failed, as the session’s own end, and the session is over', async () => {
    const h = await open();
    h.control({ exitDuringTurn: 1 });
    const s = start(h);
    s.send(h.prompts.t1);
    expect(await s.ended('turn-1')).toEqual({ type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: false, failure: 'connection-lost' });
    expect(s.notices()).toEqual(['connection-lost']);
    await expect(s.session.closed).resolves.toEqual({ ok: true });
    // Never started again by itself: the fake launched once.
    expect(h.only().entry.launches).toHaveLength(1);
    // A model had answered before the end: the reference came, and the next prompt's session resumes it (C90).
    expect(s.reference()).toBe(h.only().id);
  });

  it('with a worker open: the worker is ended as failed first, then the turn', async () => {
    const h = await open();
    h.control({ exitWithWorker: 1 });
    const s = start(h);
    s.send(h.prompts.t3);
    await s.ended('turn-1');
    expect(s.events.slice(-3).map((event) => (event.type === 'notice' ? `notice:${event.kind}` : event.type))).toEqual(['worker-ended', 'notice:connection-lost', 'turn-ended']);
    expect(s.events.at(-3)).toMatchObject({ outcome: 'failed' });
    expect(s.events.at(-1)).toMatchObject({ outcome: 'failed', reported: false });
  });

  it('after a turn, with its worker still running: the worker is ended as failed, with its own notice', async () => {
    const h = await open();
    h.control({ exitAfterTurnWithWorker: 1 });
    const s = start(h);
    s.send(h.prompts.self);
    // The CLI's own end came first: the turn completed.
    expect(await s.ended('turn-1')).toMatchObject({ outcome: 'completed', reported: true });
    await s.until((event) => event.type === 'notice' && event.kind === 'workers-lost');
    expect(s.events.slice(-2)).toMatchObject([{ type: 'worker-ended', outcome: 'failed' }, { type: 'notice', kind: 'workers-lost' }]);
    await expect(s.session.closed).resolves.toEqual({ ok: true });
  });

  it('holds itself alone when its end cannot be confirmed: another session of the instance, and a usage read, go on (C71)', async () => {
    const h = await open({ env: { FATG_SMOKE_CLAUDE_DESCENDANT: 'hold' } });
    const held = start(h);
    held.send(h.prompts.t1);
    await held.ended('turn-1');
    // Its descendant keeps the fake's output open after the fake has ended: the tree cannot be confirmed gone.
    const result = await held.session.close();
    if (!result.ok) {
      await expect(held.session.recheck()).resolves.toEqual({ ok: false });
      // The scope is open to launches all the same.
      const other = start(h);
      other.send(h.prompts.t1);
      expect(await other.ended('turn-1')).toMatchObject({ outcome: 'completed' });
      expect(await h.provider.getUsage(new AbortController().signal)).toMatchObject({ kind: 'usage' });
      await other.session.close();
    }
    // On a system that ends a tree whole, the close is confirmed and there is nothing to hold: both are in order.
    expect(typeof result.ok).toBe('boolean');
  });
});
