// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V5, V6, V58 (docs/planning/_archive/M15.md; C12, C20–C23, C26, C29, C130): starting a session and running
// a turn, on the real adapter and process layer against the replay fake. Each end says whether Codex
// reported it (docs/planning/_archive/M18.md, V26; C59): a failed or stopped start is the adapter's own.
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentEventSchema } from '@shared/contracts/agent-events';
import { CODEX_INSTANCES } from '../../src/main/providers/codex/descriptor';
import { codexHarness, eventually, type Harness, PROMPTS, watch, STREAMED } from './harness';

let harness: Harness | undefined;
afterEach(async () => { await harness?.dispose(); harness = undefined; });
const start = (h: Harness, facet = h.facet) => watch(facet.start({ folder: h.project, model: 'gpt-6-astra', effort: 'low', speed: null, otherFolders: [], mode: 'read-only', processKey: 'process-1' }));

describe('the first prompt (V5)', () => {
  it('starts no thread at Start session, and one at the first prompt, in exactly the folder it was given', async () => {
    const h = harness = await codexHarness();
    const session = start(h);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(h.threads()).toEqual({});
    // The existing connection's process, and no other.
    expect(h.pids()).toHaveLength(1);

    session.send(PROMPTS.t1);
    expect((await session.ended('turn-1')).outcome).toBe('completed');
    const threads = Object.entries(h.threads());
    expect(threads).toHaveLength(1);
    const [id, thread] = threads[0] as [string, ReturnType<Harness['threads']>[string]];
    expect(thread.cwd).toBe(h.project);
    expect(thread.kept).toBe(true);
    expect(thread.turns).toEqual([STREAMED.t1]);
    // The reference is that thread's id, reported with the folder.
    expect(session.events.find((event) => event.type === 'session-started')).toEqual({ type: 'session-started', reference: id, folder: h.project });
    for (const event of session.events) expect(AgentEventSchema.safeParse(event).success, event.type).toBe(true);
  });

  it('shows the user’s message, the commentary and the answer of T1, with the file it read as its action', async () => {
    const h = harness = await codexHarness();
    const session = start(h);
    session.send(PROMPTS.t1);
    await session.ended('turn-1');
    const messages = session.events.filter((event) => event.type === 'message');
    expect(messages.map((event) => [event.role, event.phase])).toEqual([['user', null], ['assistant', 'commentary'], ['assistant', 'final']]);
    expect(messages[2]?.text).toContain('Biscuit');
    expect(session.events.find((event) => event.type === 'action-changed' && event.kind === 'reading')).toMatchObject({ file: 'sample.txt' });
    expect(session.types().indexOf('turn-started')).toBeLessThan(session.types().indexOf('session-started'));
    expect(session.types().at(-1)).toBe('turn-ended');
  });

  it('launches a session’s process like the existing one: the same argument, in fat-g’s own probe folder, the home as inherited', async () => {
    const h = harness = await codexHarness();
    const session = start(h);
    session.send(PROMPTS.t1);
    await session.ended('turn-1');
    const [thread] = Object.values(h.threads());
    expect(thread?.launches).toHaveLength(1);
    const launch = thread?.launches[0];
    expect(launch?.args).toEqual(['app-server']);
    // Both resolved: macOS's temporary folder is behind a link, and a process reports where it really is.
    expect(realpathSync(launch?.cwd ?? '').toLowerCase()).toBe(realpathSync(h.context.probeDirectory).toLowerCase());
    expect(launch?.cwd.toLowerCase()).not.toContain(path.basename(h.project).toLowerCase() + path.sep);
    expect(launch?.home).toBeNull();
    // A process of its own: not the one the account reads run on.
    expect(h.pids()).toHaveLength(2);
    expect(h.pids()[0]).not.toBe(launch?.pid);
  });

  it('gives an added account’s session the variable set to its folder, through its scope', async () => {
    const h = harness = await codexHarness();
    const folder = path.join(h.dir, 'second-home');
    const added = await h.adapter({ variable: CODEX_INSTANCES.variable, folder, withhold: CODEX_INSTANCES.withhold });
    const session = start(h, added.facet);
    session.send(PROMPTS.t1);
    await session.ended('turn-1');
    const thread = Object.values(h.threads()).find((entry) => entry.launches[0]?.home !== null);
    expect(thread?.launches[0]?.home).toBe(folder);
    expect(thread?.launches[0]?.args).toEqual(['app-server']);
  });

  it('takes one folder: a list of others handed to it changes nothing of its launch, and the turn runs as it does today (M16, V24; C61)', async () => {
    const h = harness = await codexHarness();
    expect(h.provider.descriptor.capabilities.otherFolders).toBe(false);
    const elsewhere = path.join(h.dir, 'elsewhere');
    const session = watch(h.facet.start({ folder: h.project, model: 'gpt-6-astra', effort: 'low', speed: null, otherFolders: [elsewhere], mode: 'read-only', processKey: 'process-1' }));
    session.send(PROMPTS.t1);
    // The fake replays a capture only for the frames that capture was made with: the turn completing is the frames being today's.
    expect(await session.ended('turn-1')).toMatchObject({ outcome: 'completed', reported: true });
    const [thread] = Object.values(h.threads());
    expect(thread).toMatchObject({ cwd: h.project, turns: [STREAMED.t1] });
    expect(thread?.launches).toHaveLength(1);
    expect(thread?.launches[0]?.args).toEqual(['app-server']);
    expect(JSON.stringify(thread)).not.toContain('elsewhere');
  });

  it.each(['sandbox', 'network', 'policy'] as const)('sends no prompt when the start reply reports another %s, says why, and ends its process', async (kind) => {
    const h = harness = await codexHarness();
    h.control({ otherSandbox: kind });
    const session = start(h);
    session.send(PROMPTS.t1);
    const end = await session.ended('turn-1');
    expect(end).toEqual({ type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: false, failure: 'not-read-only' });
    expect(session.notices()).toEqual(['not-read-only']);
    expect(Object.values(h.threads())[0]?.turns).toEqual([]);
    expect(session.reference()).toBeUndefined();
    await expect(session.session.closed).resolves.toEqual({ ok: true });
    await eventually(() => h.running().length === 1, 5000, 'the session process ending');
  });
});

describe('a turn (V6)', () => {
  it('runs two sessions’ turns at once, each in a process of its own', async () => {
    const h = harness = await codexHarness();
    const a = start(h);
    const b = start(h);
    a.send(PROMPTS.t3);
    b.send(PROMPTS.t1);
    const [endA, endB] = await Promise.all([a.ended('turn-1'), b.ended('turn-1')]);
    expect([endA.outcome, endB.outcome]).toEqual(['completed', 'completed']);
    expect(a.reference()).not.toBe(b.reference());
    const pids = Object.values(h.threads()).map((thread) => thread.launches[0]?.pid);
    expect(new Set(pids).size).toBe(2);
    // The worker of one is no business of the other.
    expect(a.types()).toContain('worker-ended');
    expect(b.types()).not.toContain('worker-started');
  });

  it('takes the next prompt on the same process, with no second start', async () => {
    const h = harness = await codexHarness();
    const session = start(h);
    session.send(PROMPTS.t1, 1);
    await session.ended('turn-1');
    session.send(PROMPTS.t6, 2);
    await session.ended('turn-2');
    const [thread] = Object.values(h.threads());
    expect(Object.keys(h.threads())).toHaveLength(1);
    expect(thread?.turns).toEqual([STREAMED.t1, 't6-question']);
    expect(thread?.launches).toHaveLength(1);
    expect(session.events.filter((event) => event.type === 'session-started')).toHaveLength(1);
    expect(session.events.find((event) => event.type === 'message' && event.questions !== undefined)).toMatchObject({ questions: [{ title: 'Should I read notes-1.txt or notes-2.txt?', options: ['notes-1.txt', 'notes-2.txt'] }] });
  });

  it('fails a turn with the CLI’s own message, and keeps its process for the next prompt', async () => {
    const h = harness = await codexHarness();
    const session = start(h);
    session.send(PROMPTS.t5);
    expect(await session.ended('turn-1')).toEqual({ type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: true, failure: 'turn-failed' });
    expect(session.events.find((event) => event.type === 'notice')).toMatchObject({ kind: 'turn-failed', detail: expect.stringContaining('is not supported') as string });
    session.send(PROMPTS.t1, 2);
    expect((await session.ended('turn-2')).outcome).toBe('completed');
    expect(Object.values(h.threads())[0]?.launches).toHaveLength(1);
  });
});

describe('a start that is stopped or fails before its turn has started (V58; C130)', () => {
  it('reports no reference, and the next prompt starts a thread again', async () => {
    const h = harness = await codexHarness();
    h.control({ hang: 'open' });
    const first = start(h);
    first.send(PROMPTS.t1);
    await eventually(() => h.pids().length === 2, 5000, 'the session process starting');
    first.session.stop();
    expect(await first.ended('turn-1')).toEqual({ type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: false });
    expect(first.reference()).toBeUndefined();
    await first.session.closed;

    h.control({});
    const second = start(h);
    second.send(PROMPTS.t1);
    await second.ended('turn-1');
    const kept = Object.entries(h.threads()).filter(([, thread]) => thread.kept);
    expect(kept).toHaveLength(1);
    expect(second.reference()).toBe(kept[0]?.[0]);
  });

  it('names the step that got no answer inside its deadline, and sends nothing again', async () => {
    // Only the hung step has a short deadline: on a slow machine a short one for the open ends the start there first.
    const h = harness = await codexHarness({ timings: { sendMs: 300 } });
    h.control({ hang: 'send' });
    const session = start(h);
    session.send(PROMPTS.t1);
    expect(await session.ended('turn-1')).toEqual({ type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: false, failure: 'start-failed' });
    expect(session.events.find((event) => event.type === 'notice')).toEqual({ type: 'notice', kind: 'start-failed', turnId: 'turn-1', step: 'send' });
    expect(session.reference()).toBeUndefined();
    await expect(session.session.closed).resolves.toEqual({ ok: true });
    // One thread was started, and no turn of it.
    expect(Object.values(h.threads()).map((thread) => [thread.kept, thread.turns])).toEqual([[false, []]]);
  });

  it('fails the start when the process ends during it', async () => {
    const h = harness = await codexHarness();
    h.control({ exitDuringStart: 1 });
    const session = start(h);
    session.send(PROMPTS.t1);
    expect((await session.ended('turn-1')).failure).toBe('start-failed');
    expect(session.events.find((event) => event.type === 'notice')).toMatchObject({ kind: 'start-failed', step: 'open' });
    await expect(session.session.closed).resolves.toEqual({ ok: true });
  });
});
