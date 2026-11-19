// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V5, V13 (docs/planning/_archive/M16.md; C16, C31, C35, C40, C41, C70, C76): what a session's process sends,
// and what the adapter does with what it cannot or does not read — on the real adapter and process
// layer against the replay fake. A line over the limit, a `result` lost to it, a text past its
// bound, a text shown while its `result` is held back, and a turn the CLI starts by itself.
//
// Since M22 (docs/planning/_archive/M22.md, Design 8; C67, C71) a line over the limit is read for its kind,
// from its first bytes, and one that may be a request stops what runs. The CLI writes a `result`
// with its `type` after two nested values, as the captures hold it, so a `result` over the limit
// is such a line: its kind cannot be read, and its turn is stopped for it, with the notice — beside
// what the closing frame then says of the turn, which is as before.
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_MESSAGE_TEXT } from '@shared/contracts/agent-events';
import type { ClaudeChatSession } from '../../../src/main/providers/claude/chat-session';
import { claudeHarness, eventually, type Harness, type HarnessOptions, READING, watch } from './harness';

let harness: Harness | undefined;
afterEach(async () => { await harness?.dispose(); harness = undefined; });
const open = async (options?: HarnessOptions): Promise<Harness> => (harness = await claudeHarness(options));
const start = (h: Harness) => watch(h.facet.start({ folder: h.project, model: 'sonnet', effort: 'low', speed: null, otherFolders: [], ...READING }));
const counts = (session: unknown) => (session as ClaudeChatSession).counts;

describe('a line over the line limit (V5; C16)', () => {
  it('is dropped and counted with the session up, and the turn goes on to its own end', async () => {
    const h = await open();
    h.control({ oversize: 'toolResult' });
    const s = start(h);
    s.send(h.prompts.t1);
    expect(await s.ended('turn-1')).toMatchObject({ outcome: 'completed', reported: true });
    expect(counts(s.session).dropped.oversized).toBe(1);
    expect(h.diagnostics()).toContainEqual({ type: 'frame-dropped', reason: 'oversized' });
    // The answer came after the dropped line, and the process is still there for the next prompt.
    expect(s.events.some((event) => event.type === 'message' && event.text === 'The cat is called Biscuit.')).toBe(true);
    expect(s.notices()).toEqual([]);
    s.send(h.prompts.t1, 2);
    expect(await s.ended('turn-2')).toMatchObject({ outcome: 'completed' });
    expect(h.only().entry.launches).toHaveLength(1);
  });

  it('takes more than 4 MiB of output in all without ending the session: four turns, each with a megabyte dropped', async () => {
    const h = await open();
    h.control({ oversize: 'toolResult' });
    const s = start(h);
    for (let n = 1; n <= 5; n++) {
      s.send(h.prompts.t1, n);
      expect(await s.ended(`turn-${n}`)).toMatchObject({ outcome: 'completed' });
    }
    expect(counts(s.session).dropped.oversized).toBe(5);
    expect(h.only().entry.launches).toHaveLength(1);
    expect(h.running('chat')).toHaveLength(1);
  });
});

describe('a `result` lost to the line limit (V13; C41, C76)', () => {
  it('is made up for by the closing frame: the turn ends completed, the CLI’s own end, with its answer named and the notice that output was lost — after the notice of a line that may have been a request (M22, C71)', async () => {
    const h = await open();
    h.control({ oversize: 'result' });
    const s = start(h);
    s.send(h.prompts.t1);
    const end = await s.ended('turn-1');
    const [message] = s.events.flatMap((event) => (event.type === 'message' ? [event] : []));
    expect(end).toEqual({ type: 'turn-ended', turnId: 'turn-1', outcome: 'completed', reported: true, answerItemId: message?.itemId });
    // The line's kind could not be read from its first bytes, so the turn was stopped for it (M22, C71): the
    // Stop found the turn already over, and the closing frame says how it ended.
    expect(s.notices()).toEqual(['line-too-long', 'output-lost']);
    expect(s.events.find((event) => event.type === 'notice' && event.kind === 'line-too-long')).toMatchObject({ turnId: 'turn-1', size: expect.any(Number) as number });
    expect(counts(s.session).dropped.oversized).toBe(1);
    // Stopped by the session's own path, and no process was closed for the line.
    await eventually(() => h.only().entry.interrupts.length === 1, 10_000, 'the Stop reaching the process');
    expect(h.running('chat')).toHaveLength(1);
  });

  it('ends a turn whose closing frame reads `cancelled` as interrupted, the Stop that line brought having been pressed; a failed turn’s `end-lost` is chat-session.test.ts’s, on a scripted process', async () => {
    const h = await open();
    h.control({ oversize: 'result' });
    const s = start(h);
    s.send(h.prompts.t5);
    // T5's `result` is small: the control pads its text all the same, and its closing frame reads `cancelled`.
    // Before M22 that read as the turn's failure. The line may have been a request, so the turn was
    // stopped for it (C71), and a cancelled turn that was stopped is an interrupted one.
    expect(await s.ended('turn-1')).toEqual({ type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: true });
    expect(s.notices()).toEqual(['line-too-long', 'output-lost']);
    // The CLI's own text for the failure was read before the lost frame, and is no message.
    expect(s.events.some((event) => event.type === 'message')).toBe(false);
  });
});

describe('a text (V13; C35, C70)', () => {
  it('past its bound is cut to it and marked, and still delivered', async () => {
    const h = await open();
    h.control({ longText: true });
    const s = start(h);
    s.send(h.prompts.t1);
    await s.ended('turn-1');
    const [message] = s.events.flatMap((event) => (event.type === 'message' ? [event] : []));
    expect(message?.text).toHaveLength(MAX_MESSAGE_TEXT);
    expect(message?.cut).toBe(true);
    expect(message?.text.startsWith('The cat is called Biscuit.')).toBe(true);
    expect(counts(s.session).dropped.oversized).toBe(0);
  });

  it('is shown when it arrives, while its `result` is held back as a Stop hook holds it', async () => {
    const h = await open();
    h.control({ holdResult: 1500 });
    const s = start(h);
    s.send(h.prompts.t1);
    await s.until((event) => event.type === 'message');
    const shown = Date.now();
    // The turn is still running: nothing has settled the text, and nothing needs to.
    expect(s.events.some((event) => event.type === 'turn-ended')).toBe(false);
    const end = await s.ended('turn-1');
    expect(Date.now() - shown).toBeGreaterThanOrEqual(1000);
    expect(end).toMatchObject({ outcome: 'completed', reported: true });
    expect(end.answerItemId).toBe(s.events.flatMap((event) => (event.type === 'message' ? [event.itemId] : []))[0]);
  });
});

describe('a turn the CLI starts by itself (V13; C31, C40)', () => {
  it('is dropped and counted, while a prompt written meanwhile keeps its own turn, and the worker’s frames are mapped whenever they come', async () => {
    const h = await open();
    const s = start(h);
    s.send(h.prompts.self, 1);
    expect(await s.ended('turn-1')).toMatchObject({ outcome: 'completed', reported: true });
    s.send(h.prompts.ok, 2);
    expect(await s.ended('turn-2')).toMatchObject({ outcome: 'completed', reported: true });
    // The worker ends after both turns; then the CLI's own turn runs to its `result`.
    await s.until((event) => event.type === 'worker-ended', 20_000);
    await eventually(() => counts(s.session).dropped['other-turn'] === 3, 10_000, 'the self-started turn’s three frames being dropped');
    // The session's own messages: what its worker said is the worker's, under its id (M20a, C20, C22).
    const texts = s.events.flatMap((event) => (event.type === 'message' && event.workerId === undefined ? [[event.turnId, event.text.slice(0, 12)]] : []));
    expect(texts).toEqual([['turn-1', 'The sub-agen'], ['turn-2', 'ok']]);
    const [worker] = s.events.flatMap((event) => (event.type === 'worker-started' ? [event.workerId] : []));
    const workers = s.events.filter((event) => (event.type === 'message' || event.type === 'activity-started' || event.type === 'activity-ended') && event.workerId !== undefined);
    expect(workers.length).toBeGreaterThan(0);
    // Each names the worker and the turn that started it, though that turn had ended, and another had run, by the time most of them came.
    expect(workers.every((event) => 'workerId' in event && event.workerId === worker && 'turnId' in event && event.turnId === 'turn-1')).toBe(true);
    expect(JSON.stringify(s.events)).not.toContain('The background agent finished');
    expect(s.events.filter((event) => event.type === 'turn-ended')).toHaveLength(2);
    const progress = s.events.filter((event) => event.type === 'worker-progressed');
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.at(-1)?.kind).toBe('thinking');
    expect(s.events.filter((event) => event.type === 'worker-ended')).toEqual([expect.objectContaining({ outcome: 'completed' })]);
    // The session is still open: its `init` passed the check, and nothing ended the process.
    expect(h.running('chat')).toHaveLength(1);
    expect(s.notices()).toEqual([]);
  });
});

describe('a worker’s closing frames (V13; C39)', () => {
  it('that never come leave the worker open after its turn’s completed end, and one that names a failed status ends it as failed', async () => {
    const open1 = await open();
    open1.control({ workerNoClose: true });
    const a = start(open1);
    a.send(open1.prompts.t3);
    expect(await a.ended('turn-1')).toMatchObject({ outcome: 'completed' });
    expect(a.events.filter((event) => event.type === 'worker-started')).toHaveLength(1);
    expect(a.events.some((event) => event.type === 'worker-ended')).toBe(false);
    await open1.dispose();

    const failed = await open();
    failed.control({ workerFailed: true });
    const b = start(failed);
    b.send(failed.prompts.t3);
    await b.ended('turn-1');
    expect(b.events.filter((event) => event.type === 'worker-ended')).toEqual([expect.objectContaining({ outcome: 'failed' })]);
  });
});
