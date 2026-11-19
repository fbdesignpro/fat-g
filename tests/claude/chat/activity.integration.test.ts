// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V4, V6, V14 (docs/planning/_archive/M20a.md; C6, C16–C18, C20–C23, C29, C34, C51, C52): what a Claude
// session does between its messages, on the real adapter and process layer against the replay fake,
// which sends M19's captures — first as the adapter tells it, then through the app's own runtime,
// chat service and conversation store. Each fault is a captured frame with one named change
// (tests/fixtures/claude/replay.mjs), on the turn's first tool use of the session's own.
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AgentEvent, AgentEventSchema } from '@shared/contracts/agent-events';
import type { ChatPush } from '@shared/contracts/chat';
import type { ConversationItem } from '@shared/contracts/conversation';
import type { ProviderSession, SessionFacet } from '@shared/provider-kit/sessions';
import type { ClaudeChatSession } from '../../../src/main/providers/claude/chat-session';
import { type App, launchApp, placeRecords, S, sessionEntry, until } from '../../sessions/app';
import { claudeHarness, type Harness, type HarnessOptions, READING, watch } from './harness';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
/** What T1's `Read` returned: the file's own line. */
const READ = 'Biscuit';

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
const start = (h: Harness) => watch(h.facet.start({ folder: h.project, model: 'sonnet', effort: 'low', speed: null, otherFolders: [], ...READING }));
const counts = (session: unknown) => (session as ClaudeChatSession).counts;
const of = <T extends AgentEvent['type']>(events: readonly AgentEvent[], type: T): Extract<AgentEvent, { type: T }>[] => events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type);

describe('a tool’s use and its result as the adapter tells it (V4; C17, C18)', () => {
  it('starts T1’s read at its tool use, with the tool’s name, its input and the file it names, and ends it at its result, with the result as its output', async () => {
    const h = await open();
    const s = start(h);
    s.send(h.prompts.t1);
    expect((await s.ended('turn-1')).outcome).toBe('completed');
    for (const event of s.events) expect(AgentEventSchema.safeParse(event).success, event.type).toBe(true);
    const [started] = of(s.events, 'activity-started');
    const [ended] = of(s.events, 'activity-ended');
    expect([of(s.events, 'activity-started').length, of(s.events, 'activity-ended').length]).toEqual([1, 1]);
    expect(started).toMatchObject({ turnId: 'turn-1', activityType: 'read', name: 'Read', summary: 'sample.txt', files: [{ line: null }] });
    // The path as the CLI wrote it: the session's folder, and the separator of the system the capture was taken on, whatever this one's is.
    const named = started?.files?.[0]?.path ?? '';
    expect(named.startsWith(h.project)).toBe(true);
    expect(named.slice(h.project.length)).toMatch(/^[\\/]sample\.txt$/);
    expect(JSON.parse(started?.input ?? '{}')).toEqual({ file_path: named });
    // Claude says no time of its own for either (C7).
    expect(started?.providerAt).toBeUndefined();
    expect(ended).toMatchObject({ turnId: 'turn-1', itemId: started?.itemId, status: 'completed', output: expect.stringContaining(READ) as string });
    expect(ended?.durationMs ?? ended?.exitCode ?? ended?.cut).toBeUndefined();
    // Before the answer that reports it, and of the session's own.
    expect(s.events.indexOf(ended as AgentEvent)).toBeLessThan(s.events.findIndex((event) => event.type === 'message'));
    expect(started?.workerId ?? ended?.workerId).toBeUndefined();
    expect(Object.values(counts(s.session).dropped).every((count) => count === 0)).toBe(true);
  });

  it.each([
    ['toolUnknown', { toolUnknown: true }, { activityType: 'other', name: 'ALaterTool' }, { status: 'completed' }],
    ['toolError', { toolError: true }, { activityType: 'read', name: 'Read' }, { status: 'failed' }],
  ] as const)('%s: one named change to the first tool, and the turn goes on to its answer', async (_name, control, begins, ends) => {
    const h = await open();
    h.control(control);
    const s = start(h);
    s.send(h.prompts.t1);
    expect((await s.ended('turn-1')).outcome).toBe('completed');
    const [started] = of(s.events, 'activity-started');
    expect(started).toMatchObject(begins);
    expect(of(s.events, 'activity-ended')).toMatchObject([{ itemId: started?.itemId, ...ends, output: expect.stringContaining(READ) as string }]);
    expect(s.events.some((event) => event.type === 'message' && event.text === 'The cat is called Biscuit.')).toBe(true);
    expect(Object.values(counts(s.session).dropped).every((count) => count === 0)).toBe(true);
  });

  it('toolUnknown: a tool the adapter does not know keeps its input, and names no file', async () => {
    const h = await open();
    h.control({ toolUnknown: true });
    const s = start(h);
    s.send(h.prompts.t1);
    await s.ended('turn-1');
    const [started] = of(s.events, 'activity-started');
    expect(started?.input).toContain('sample.txt');
    expect(started?.files ?? []).toEqual([]);
  });

  it('noToolResult: the tool’s end never comes, and no event ends it', async () => {
    const h = await open();
    h.control({ noToolResult: true });
    const s = start(h);
    s.send(h.prompts.t1);
    expect((await s.ended('turn-1')).outcome).toBe('completed');
    expect(of(s.events, 'activity-started')).toHaveLength(1);
    expect(of(s.events, 'activity-ended')).toEqual([]);
  });

  it('longText toolResult: a result past its bound is cut in the adapter, its first and last parts kept', async () => {
    const h = await open();
    h.control({ longText: 'toolResult' });
    const s = start(h);
    s.send(h.prompts.t1);
    await s.ended('turn-1');
    const [ended] = of(s.events, 'activity-ended');
    expect(ended).toMatchObject({ status: 'completed', cut: { fields: ['output'], output: { omitted: expect.any(Number) as number, at: 10_000 } } });
    expect(ended?.output?.length).toBeLessThanOrEqual(20_000);
    // The file's own line is in the first part that is kept.
    expect(ended?.output).toContain(READ);
    expect(ended?.output?.endsWith('THE END')).toBe(true);
    expect(AgentEventSchema.safeParse(ended).success).toBe(true);
  });

  it('quotedResult: a line of over two mebibytes is taken, under a session’s limit of four; oversize toolResult: one over it is dropped, and counted', async () => {
    const taken = await open();
    taken.control({ quotedResult: true });
    const first = start(taken);
    first.send(taken.prompts.t1);
    expect((await first.ended('turn-1', 30_000)).outcome).toBe('completed');
    expect(counts(first.session).dropped.oversized).toBe(0);
    expect(of(first.events, 'activity-ended')).toMatchObject([{ status: 'completed', cut: { fields: ['output'] } }]);
    expect(of(first.events, 'activity-ended')[0]?.output?.endsWith('"')).toBe(true);
    await taken.dispose();

    const dropped = await open();
    dropped.control({ oversize: 'toolResult' });
    const second = start(dropped);
    second.send(dropped.prompts.t1);
    expect((await second.ended('turn-1', 30_000)).outcome).toBe('completed');
    expect(counts(second.session).dropped.oversized).toBe(1);
    // Its tool was started, and nothing ended it: nothing of the line was read.
    expect(of(second.events, 'activity-started')).toHaveLength(1);
    expect(of(second.events, 'activity-ended')).toEqual([]);
  }, 90_000);
});

describe('a worker’s work as the adapter tells it (V4; C20–C23)', () => {
  it('tells T3’s worker’s own tool use and result under the worker’s id, in the turn that started it, and ends the item that started it with the worker', async () => {
    const h = await open();
    const s = start(h);
    s.send(h.prompts.t3);
    expect((await s.ended('turn-1', 30_000)).outcome).toBe('completed');
    for (const event of s.events) expect(AgentEventSchema.safeParse(event).success, event.type).toBe(true);
    const [worker] = of(s.events, 'worker-started');
    const mine = of(s.events, 'activity-started').filter((event) => event.workerId === undefined);
    const theirs = of(s.events, 'activity-started').filter((event) => event.workerId !== undefined);
    // The session's own: the `Agent` tool use, once the CLI named the worker it started, and once its first frame named its model (M106, C14).
    expect(mine.map((event) => [event.activityType, event.name, event.pairedWorkerId])).toEqual([['worker', 'Agent', undefined], ['worker', 'Agent', worker?.workerId], ['worker', 'Agent', worker?.workerId]]);
    expect(typeof mine[2]?.model).toBe('string');
    // The worker's: its read, under its id.
    expect(theirs).toMatchObject([{ turnId: 'turn-1', workerId: worker?.workerId, activityType: 'read', name: 'Read' }]);
    expect(of(s.events, 'activity-ended').find((event) => event.itemId === theirs[0]?.itemId)).toMatchObject({ workerId: worker?.workerId, status: 'completed', output: expect.stringContaining('blue drawer') as string });
    // The item that started the worker ends as the worker does, before the worker's own end is told,
    // and its tool's result ends nothing of it (C23).
    const ends = of(s.events, 'activity-ended').filter((event) => event.itemId === mine[0]?.itemId);
    expect(ends.every((event) => event.status === 'completed' && event.workerId === undefined)).toBe(true);
    expect(s.events.indexOf(ends[0] as AgentEvent)).toBeLessThan(s.events.findIndex((event) => event.type === 'worker-ended'));
    expect(Object.values(counts(s.session).dropped).every((count) => count === 0)).toBe(true);
  }, 60_000);

  it('toolUnknown and toolError change nothing of a worker’s own tool: each is on the session’s first tool use', async () => {
    const h = await open();
    h.control({ toolError: true });
    const s = start(h);
    s.send(h.prompts.t3);
    await s.ended('turn-1', 30_000);
    const theirs = of(s.events, 'activity-ended').filter((event) => event.workerId !== undefined);
    expect(theirs).toMatchObject([{ status: 'completed' }]);
  }, 60_000);
});

// ── Through the app: the runtime, the chat service and a conversation store on disk ───────────
const dataDir = (h: Harness): string => path.join(h.dir, 'records');
const place = (h: Harness): void => placeRecords(dataDir(h), h.project, 'claude', [sessionEntry(1, 'claude', { model: 'sonnet' })]);
function launch(h: Harness, events?: AgentEvent[]): App {
  const tap = (session: ProviderSession): ProviderSession => { session.subscribe((event) => { events?.push(event); }); return session; };
  const facet: SessionFacet = { ...h.facet, start: (options) => tap(h.facet.start(options)), resume: (options) => tap(h.facet.resume(options)) };
  const app = launchApp({ dir: dataDir(h), descriptor: h.provider.descriptor, facet: () => facet, log });
  apps.push(app);
  return app;
}
const idle = (app: App) => until(() => !app.service.isRunning(S(1)), 'the session coming to rest', 30_000);
async function turn(app: App, prompt: string): Promise<void> {
  expect(await app.runtime.send(S(1), prompt)).toEqual({ status: 'accepted' });
  await idle(app);
  await app.service.settled();
}
const done = (app: App): ConversationItem[] => app.read(1).items.filter((item) => item.kind === 'activity');
const pushesOf = (pushes: readonly ChatPush[], itemId: string): string[] => pushes.flatMap((push) => ('item' in push && push.item.id === itemId ? [`item:${push.item.state}`] : []));
const said = (): string => JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls]);

describe('a tool’s use through the app (V6, V7; C29, C30, C34)', () => {
  it('keeps T1’s read between the prompt and the answer, ended, with fat-g’s own duration, and says of it only its type', async () => {
    const h = await open();
    place(h);
    const app = launch(h);
    await turn(app, h.prompts.t1);
    expect(app.read(1).items.map((item) => (item.kind === 'activity' ? `activity:${item.activity?.type}` : `${item.role}:${item.phase}`))).toEqual(['user:null', 'activity:read', 'assistant:final']);
    const [read] = done(app);
    expect(read).toMatchObject({ state: 'complete', workerId: null, origin: 'local', activity: { status: 'completed', name: 'Read', summary: 'sample.txt', exitCode: null, cut: null, duration: { provenance: 'local' }, output: expect.stringContaining(READ) as string } });
    expect(read?.time.providerAt).toBeNull();
    expect([...new Set(pushesOf(app.pushes, read?.id ?? ''))].sort()).toEqual(['item:complete', 'item:streaming']);
    // The file's line is the answer's own word too, so the leak is looked for by the tool's input: the path it named.
    expect(said()).not.toContain('file_path');
    expect(JSON.stringify(app.service.snapshot())).not.toContain('file_path');
    const told = app.chat.activityCounts();
    expect(told.started.read).toBe(1);
    expect(told.cut).toBe(0);
    expect(Object.values(told.dropped).every((count) => count === 0)).toBe(true);
    // The same after a restart, from the store.
    const recorded = app.read(1).items;
    await app.quit();
    apps = [];
    expect(launch(h).read(1).items).toEqual(recorded);
  }, 60_000);

  it('noToolResult: a tool whose result never came reads unfinished once its turn has ended', async () => {
    const h = await open();
    place(h);
    h.control({ noToolResult: true });
    const app = launch(h);
    await turn(app, h.prompts.t1);
    expect(app.read(1).turns[0]).toMatchObject({ state: 'ended', outcome: 'completed' });
    expect(done(app)).toMatchObject([{ state: 'partial', activity: { status: 'unfinished', output: null, duration: null } }]);
  }, 60_000);

  it('toolError: a result with its error flag fails the item, with what it said as the output', async () => {
    const h = await open();
    place(h);
    h.control({ toolError: true });
    const app = launch(h);
    await turn(app, h.prompts.t1);
    expect(done(app)).toMatchObject([{ state: 'complete', activity: { status: 'failed', output: expect.stringContaining(READ) as string } }]);
  }, 60_000);

  it('longText toolResult: the cut output is kept with what was left out counted, and counted as cut', async () => {
    const h = await open();
    place(h);
    h.control({ longText: 'toolResult' });
    const app = launch(h);
    await turn(app, h.prompts.t1);
    const [read] = done(app);
    expect(read).toMatchObject({ state: 'complete', activity: { status: 'completed', cut: { fields: ['output'], output: { at: 10_000 } } } });
    expect(read?.activity?.cut?.output?.omitted).toBeGreaterThan(0);
    expect(read?.activity?.output?.endsWith('THE END')).toBe(true);
    expect(app.chat.activityCounts().cut).toBe(1);
  }, 60_000);

  it('files T3’s worker’s work under its own id, in the turn that started it, and shows the item that started it under the agent list’s label (C20–C23)', async () => {
    const h = await open();
    place(h);
    const events: AgentEvent[] = [];
    const app = launch(h, events);
    await turn(app, h.prompts.t3);
    const [first] = app.read(1).turns;
    const workerId = of(events, 'worker-started')[0]?.workerId ?? '';
    const launched = done(app).find((item) => item.activity?.type === 'worker');
    expect(launched).toMatchObject({ turnId: first?.id, state: 'complete', workerId: null, activity: { status: 'completed', workerId, name: 'Agent' } });
    // The label is the agent list's (M14, C113), and the worker's report is the item's output (C22).
    expect(launched?.activity?.summary).toBe(app.summary(1)?.agents[0]?.label);
    expect(typeof launched?.activity?.output).toBe('string');
    const theirs = app.runtime.readWorker(S(1), workerId);
    expect(theirs).toMatchObject({ status: 'read', workerId, worker: { id: launched?.id }, older: null });
    if (theirs.status !== 'read') return;
    expect(theirs.items.map((item) => (item.kind === 'activity' ? `activity:${item.activity?.type}:${item.activity?.status}` : `${item.role}:${item.state}`))).toEqual(expect.arrayContaining(['activity:read:completed']));
    expect(theirs.items.every((item) => item.workerId === workerId && item.turnId === first?.id && item.state === 'complete')).toBe(true);
    expect(theirs.turns.map((entry) => entry.id)).toEqual([first?.id]);
    // Nothing of it is in the session's own chat.
    expect(app.read(1).items.every((item) => item.workerId === null)).toBe(true);
    // A worker the session never had is refused by its kind, and one of another session too.
    expect(app.runtime.readWorker(S(1), 'no-such-worker')).toEqual({ status: 'refused', reason: 'unknown-worker' });
    expect(app.runtime.readWorker(S(2), workerId)).toEqual({ status: 'refused', reason: 'unknown-session' });
    // That a worker's work is filed under the turn that started it when another turn runs meanwhile
    // is the adapter's (tests/claude/chat/output.integration.test.ts): the app sends no prompt to a
    // session that waits on its worker (M15, C114).
  }, 120_000);
});
