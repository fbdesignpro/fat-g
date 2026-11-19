// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V3, V6, V14 (docs/planning/_archive/M20a.md; C6, C9, C11, C14, C16, C24, C29, C34, C51, C52): what a Codex
// session does between its messages, on the real adapter and process layer against the replay fake,
// which sends K1's captures to the session handshake — first as the adapter tells it, then through
// the app's own runtime, chat service and conversation store. Each fault is a captured frame with
// one named change (tests/fixtures/codex/replay.mjs).
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AgentEvent, AgentEventSchema } from '@shared/contracts/agent-events';
import type { ChatPush } from '@shared/contracts/chat';
import type { ConversationItem } from '@shared/contracts/conversation';
import type { ProviderSession, SessionFacet } from '@shared/provider-kit/sessions';
import type { CodexSession } from '../../src/main/providers/codex/session';
import { type App, launchApp, placeRecords, S, sessionEntry } from '../sessions/app';
import { codexHarness, eventually, type Harness, promptOf, PROMPTS, watch } from './harness';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
/** K1's prompts: several steps; the same asked to track them; and the one that asks for the checklist tool by name. */
const STEPS = { plain: promptOf('m20a-steps-main'), tracked: promptOf('m20a-steps-tracked-main'), tool: promptOf('m20a-steps-tool-main') };
/** What the captures' commands printed: a file's name from the listing, and a line of a file one read. */
const NEEDLES = ['harbour-log.md', 'nextHighTide'];

let harness: Harness | undefined;
let apps: App[] = [];
afterEach(async () => {
  for (const app of apps) await app.quit();
  apps = [];
  made = [];
  await harness?.dispose();
  harness = undefined;
  for (const spy of Object.values(log)) spy.mockClear();
});

const start = (h: Harness) => watch(h.facet.start({ folder: h.project, model: 'gpt-6-astra', effort: 'low', speed: null, otherFolders: [], mode: 'read-only', processKey: 'process-1' }));

it('delivers an inline generated-image result larger than the former 4 MiB wire limit', async () => {
  const h = harness = await codexHarness();
  const data = Buffer.alloc(3_200_000, 1).toString('base64');
  h.control({ generatedImage: data });
  const session = start(h);
  session.send(STEPS.plain);
  await session.ended('turn-1');
  const image = session.events.find((event) => event.type === 'image-returned');
  expect(image?.type === 'image-returned' && image.image.kind === 'base64' && image.image.data.length === data.length).toBe(true);
  expect(counts(session).dropped.oversized).toBe(0);
});
type Started = ReturnType<typeof start>;
const counts = (session: Started) => (session.session as CodexSession).counts;
const of = <T extends AgentEvent['type']>(events: readonly AgentEvent[], type: T): Extract<AgentEvent, { type: T }>[] => events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type);
const WORK = new Set(['command', 'read', 'search']);

describe('a turn’s work as the adapter tells it (V3; C6, C9, C14, C24)', () => {
  it('starts and ends each command of K1’s turn under its own id, with its line, its output and Codex’s own duration, and its reasoning as a thinking item with no text', async () => {
    const h = harness = await codexHarness();
    const session = start(h);
    session.send(STEPS.plain);
    expect((await session.ended('turn-1', 60_000)).outcome).toBe('completed');
    for (const event of session.events) expect(AgentEventSchema.safeParse(event).success, event.type).toBe(true);
    const started = of(session.events, 'activity-started');
    const ended = of(session.events, 'activity-ended');
    // Five commands and one reasoning item, each started once and ended once, the end under the start's id.
    expect(started.map((event) => event.activityType).filter((type) => WORK.has(type))).toHaveLength(5);
    expect(started.filter((event) => event.activityType === 'thinking')).toHaveLength(1);
    expect(new Set(started.map((event) => event.itemId)).size).toBe(6);
    expect(ended.map((event) => event.itemId).sort()).toEqual(started.map((event) => event.itemId).sort());
    for (const end of ended) expect(session.events.indexOf(end)).toBeGreaterThan(session.events.findIndex((event) => event.type === 'activity-started' && event.itemId === end.itemId));
    // A command: the item's type as its name, its line as its input, and at its end its output, its exit code and how long Codex says it took.
    const commands = started.filter((event) => WORK.has(event.activityType));
    for (const command of commands) {
      expect(command).toMatchObject({ turnId: 'turn-1', name: 'commandExecution', input: expect.any(String) as string, providerAt: expect.any(Number) as number });
      expect(ended.find((event) => event.itemId === command.itemId)).toMatchObject({ status: 'completed', exitCode: 0, durationMs: expect.any(Number) as number, output: expect.any(String) as string });
    }
    // What they printed is in their ends, and in no other event but the answer that reports it.
    const outputs = JSON.stringify(ended);
    for (const needle of NEEDLES) expect(outputs, needle).toContain(needle);
    // Reasoning: Codex sends no text of it (K1), so none is kept, and none made up (C9).
    const thinking = started.find((event) => event.activityType === 'thinking');
    expect(thinking?.thinking).toBeUndefined();
    expect(ended.find((event) => event.itemId === thinking?.itemId)).toMatchObject({ status: 'completed' });
    // All of the session's own, and nothing dropped.
    expect([...started, ...ended].every((event) => event.workerId === undefined)).toBe(true);
    expect(Object.values(counts(session).dropped).every((count) => count === 0)).toBe(true);
  }, 90_000);

  it('tells the checklist as one item of the turn, replaced by each of its five notifications, where the configuration enables its tool', async () => {
    const h = harness = await codexHarness();
    h.control({ planTool: true });
    const session = start(h);
    session.send(STEPS.tool);
    expect((await session.ended('turn-1', 60_000)).outcome).toBe('completed');
    const lists = of(session.events, 'activity-started').filter((event) => event.activityType === 'checklist');
    expect(lists).toHaveLength(5);
    expect(new Set(lists.map((event) => event.itemId)).size).toBe(1);
    expect(lists[0]?.itemId).toMatch(/#plan$/);
    // The whole list each time: four steps, the first under way at first, all done at the last.
    expect(lists.map((event) => event.steps?.length)).toEqual([4, 4, 4, 4, 4]);
    expect(lists[0]?.steps?.map((step) => step.state)).toEqual(['in-progress', 'pending', 'pending', 'pending']);
    expect(lists.at(-1)?.steps?.every((step) => step.state === 'completed')).toBe(true);
    // No frame ends it: its turn's end does, in main (C11).
    expect(of(session.events, 'activity-ended').some((event) => event.itemId === lists[0]?.itemId)).toBe(false);
    expect(Object.values(counts(session).dropped).every((count) => count === 0)).toBe(true);
  }, 90_000);

  it('tells none where it does not: the same prompt runs its commands, and the turn fails at the server as captured', async () => {
    const h = harness = await codexHarness();
    const session = start(h);
    session.send(STEPS.tool);
    expect(await session.ended('turn-1', 60_000)).toMatchObject({ outcome: 'failed', reported: true });
    expect(of(session.events, 'activity-started').some((event) => event.activityType === 'checklist')).toBe(false);
    // Its four commands ran and ended before the failure.
    const commands = of(session.events, 'activity-started').filter((event) => WORK.has(event.activityType));
    expect(commands).toHaveLength(4);
    for (const command of commands) expect(of(session.events, 'activity-ended').find((event) => event.itemId === command.itemId)).toMatchObject({ status: 'completed' });
    expect(session.notices()).toContain('turn-failed');
  }, 90_000);
});

// ── Through the app: the runtime, the chat service and a conversation store on disk ───────────
const dataDir = (h: Harness) => path.join(h.dir, 'records');
const place = (h: Harness): void => placeRecords(dataDir(h), h.project, 'codex', [sessionEntry(1, 'codex', { model: 'gpt-6-astra' })]);
/** Each session the app's runtime made of the facet, for a test to read its counts. */
let made: ProviderSession[] = [];
function launch(h: Harness, events?: AgentEvent[]): App {
  const tap = (session: ProviderSession): ProviderSession => { made.push(session); session.subscribe((event) => { events?.push(event); }); return session; };
  const facet: SessionFacet = { ...h.facet, start: (options) => tap(h.facet.start(options)), resume: (options) => tap(h.facet.resume(options)) };
  const app = launchApp({ dir: dataDir(h), descriptor: h.provider.descriptor, facet: () => facet, log, userDefault: () => 'ask-first' });
  apps.push(app);
  return app;
}
const idle = (app: App) => eventually(() => !app.service.isRunning(S(1)), 60_000, 'the session coming to rest');
async function turn(app: App, prompt: string): Promise<void> {
  expect(await app.runtime.send(S(1), prompt)).toEqual({ status: 'accepted' });
  await idle(app);
  await app.service.settled();
}
const done = (app: App): ConversationItem[] => app.read(1).items.filter((item) => item.kind === 'activity');
const commandsOf = (app: App): ConversationItem[] => done(app).filter((item) => item.activity !== null && WORK.has(item.activity.type));
const pushesOf = (pushes: readonly ChatPush[], itemId: string): string[] => pushes.flatMap((push) => ('item' in push && push.item.id === itemId ? [`item:${push.item.state}`] : []));
const said = (): string => JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls]);

describe('a turn’s work through the app (V6, V7; C29, C30, C34)', () => {
  it('keeps each command between the messages it ran between, ended, and says of it only how many of each type there were', async () => {
    const h = harness = await codexHarness();
    place(h);
    const app = launch(h);
    await turn(app, STEPS.plain);
    const read = app.read(1);
    // The prompt first and the answer last, with the work between them, in the order it happened.
    expect(read.items[0]).toMatchObject({ kind: 'message', role: 'user' });
    expect(read.items.at(-1)).toMatchObject({ kind: 'message', role: 'assistant', phase: 'final' });
    expect(commandsOf(app)).toHaveLength(5);
    for (const item of commandsOf(app)) {
      expect(item).toMatchObject({ state: 'complete', workerId: null, origin: 'local', activity: { status: 'completed', exitCode: 0, name: 'commandExecution', duration: { provenance: 'provider' }, cut: null } });
      expect(item.time.providerAt).toEqual(expect.any(Number) as number);
      // As the page was pushed it: as it runs, then ended.
      expect([...new Set(pushesOf(app.pushes, item.id))].sort()).toEqual(['item:complete', 'item:streaming']);
    }
    // The thinking item is kept, with no text (C9).
    expect(done(app).filter((item) => item.activity?.type === 'thinking')).toMatchObject([{ state: 'complete', activity: { status: 'completed', thinking: null } }]);
    // What the commands printed is in the store's items…
    for (const needle of NEEDLES) expect(JSON.stringify(commandsOf(app)), needle).toContain(needle);
    // …and in no log and no summary (C30): main says kinds and counts (C34).
    for (const needle of NEEDLES) {
      expect(said(), needle).not.toContain(needle);
      expect(JSON.stringify(app.service.snapshot()), needle).not.toContain(needle);
    }
    const told = app.chat.activityCounts();
    expect(told.started.command + told.started.read + told.started.search).toBe(5);
    expect(told.started.thinking).toBe(1);
    expect(told.cut).toBe(0);
    expect(Object.values(told.dropped).every((count) => count === 0)).toBe(true);
  }, 90_000);

  it('reads the same after a restart, from the store alone, with no process started', async () => {
    const h = harness = await codexHarness();
    place(h);
    const first = launch(h);
    await turn(first, STEPS.plain);
    const recorded = first.read(1).items;
    await first.quit();
    apps = [];
    const launches = Object.values(h.threads()).flatMap((thread) => thread.launches).length;
    // That a history check then shows none of it twice is the store's contract, on the saved thread's
    // turn (tests/sessions/store-contract.ts): the fake's history is M15's own turns.
    expect(launch(h).read(1).items).toEqual(recorded);
    expect(Object.values(h.threads()).flatMap((thread) => thread.launches)).toHaveLength(launches);
  }, 120_000);

  it('keeps the checklist as one item, pushed at each update, and completes it with its turn (C11, C59)', async () => {
    const h = harness = await codexHarness();
    place(h);
    h.control({ planTool: true });
    const app = launch(h);
    await turn(app, STEPS.tool);
    const lists = done(app).filter((item) => item.activity?.type === 'checklist');
    expect(lists).toHaveLength(1);
    expect(lists[0]).toMatchObject({ state: 'complete', activity: { status: 'completed', cut: null } });
    expect(lists[0]?.activity?.steps.map((step) => step.state)).toEqual(['completed', 'completed', 'completed', 'completed']);
    expect(lists[0]?.activity?.steps.every((step) => step.text.length > 0)).toBe(true);
    // Pushed as it changed, each time whole; its completion comes with its turn's end, which tells the page to read again.
    const pushed = pushesOf(app.pushes, lists[0]?.id ?? '');
    expect(pushed).toEqual(Array.from({ length: 5 }, () => 'item:streaming'));
    const last = app.pushes.findLastIndex((push) => 'item' in push && push.item.id === lists[0]?.id);
    expect(app.pushes.slice(last + 1).some((push) => !('item' in push) && !('partial' in push))).toBe(true);
    expect(app.chat.activityCounts().started.checklist).toBe(1);
  }, 90_000);

  it('leaves the turn’s work ended under a turn that failed at the server, with the line that says so', async () => {
    const h = harness = await codexHarness();
    place(h);
    const app = launch(h);
    await turn(app, STEPS.tool);
    expect(app.read(1).turns[0]).toMatchObject({ state: 'ended', outcome: 'failed' });
    expect(commandsOf(app)).toHaveLength(4);
    expect(commandsOf(app).every((item) => item.state === 'complete' && item.activity?.status === 'completed')).toBe(true);
    expect(done(app).some((item) => item.activity?.type === 'checklist')).toBe(false);
    expect(app.read(1).items.some((item) => item.notice === 'turn-failed')).toBe(true);
  }, 90_000);
});

describe('each fault, one named change to the turn’s first command (V14; C52)', () => {
  it('itemUnknown: an item of a type the adapter does not know is kept by its name, and nothing else of it', async () => {
    const h = harness = await codexHarness();
    place(h);
    h.control({ itemUnknown: true });
    const app = launch(h);
    await turn(app, STEPS.plain);
    const other = done(app).filter((item) => item.activity?.type === 'other');
    expect(other).toMatchObject([{ state: 'complete', activity: { name: 'aLaterItemType', status: 'completed', summary: '', input: null, output: null, files: [], exitCode: null } }]);
    expect(commandsOf(app)).toHaveLength(4);
    expect(Object.values(app.chat.activityCounts().dropped).every((count) => count === 0)).toBe(true);
  }, 90_000);

  it('noItemCompletion: a command whose end never came reads unfinished once its turn has ended, and after a restart', async () => {
    const h = harness = await codexHarness();
    place(h);
    h.control({ noItemCompletion: true });
    const app = launch(h);
    await turn(app, STEPS.plain);
    expect(app.read(1).turns[0]).toMatchObject({ state: 'ended', outcome: 'completed' });
    const open = commandsOf(app).filter((item) => item.activity?.status !== 'completed');
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ state: 'partial', activity: { status: 'unfinished', output: null, exitCode: null, duration: null } });
    // The first of the turn's: the four after it ended.
    expect(commandsOf(app).map((item) => item.id).indexOf(open[0]?.id ?? '')).toBe(0);
    expect(done(app).some((item) => item.state === 'streaming' || item.activity?.status === 'running')).toBe(false);
    const recorded = app.read(1).items;
    await app.quit();
    apps = [];
    expect(launch(h).read(1).items).toEqual(recorded);
  }, 90_000);

  it('longText toolOutput: an output past its bound is kept as its first and last parts, with what was left out counted', async () => {
    const h = harness = await codexHarness();
    place(h);
    h.control({ longText: 'toolOutput' });
    const app = launch(h);
    await turn(app, STEPS.plain);
    const [first] = commandsOf(app);
    const output = first?.activity?.output ?? '';
    expect(first).toMatchObject({ state: 'complete', activity: { status: 'completed', cut: { fields: ['output'], output: { omitted: expect.any(Number) as number, at: 10_000 } } } });
    expect(output.endsWith('THE END')).toBe(true);
    expect(output.length).toBeLessThanOrEqual(20_000);
    expect(first?.activity?.cut?.output?.omitted).toBeGreaterThan(0);
    // The others are whole.
    expect(commandsOf(app).slice(1).every((item) => item.activity?.cut === null)).toBe(true);
    expect(app.chat.activityCounts().cut).toBe(1);
  }, 90_000);

  it('quotedOutput: a line of over two mebibytes is taken, under a session’s limit of four, and its output cut to its bound', async () => {
    const h = harness = await codexHarness();
    const session = start(h);
    h.control({ quotedOutput: true });
    session.send(STEPS.plain);
    expect((await session.ended('turn-1', 60_000)).outcome).toBe('completed');
    expect(counts(session).dropped.oversized).toBe(0);
    const [first] = of(session.events, 'activity-started').filter((event) => WORK.has(event.activityType));
    const end = of(session.events, 'activity-ended').find((event) => event.itemId === first?.itemId);
    expect(end).toMatchObject({ status: 'completed', cut: { fields: ['output'] } });
    expect(end?.output?.length).toBeLessThanOrEqual(20_000);
    expect(end?.output?.endsWith('"')).toBe(true);
  }, 90_000);

  it('oversize toolOutput: a line over a session’s limit is dropped and counted, nothing of it is taken, and its command reads unfinished', async () => {
    const h = harness = await codexHarness();
    place(h);
    h.control({ oversize: 'toolOutput' });
    const events: AgentEvent[] = [];
    const app = launch(h, events);
    await turn(app, STEPS.plain);
    expect(of(events, 'activity-ended').filter((event) => commandsOf(app).some((item) => item.providerItemId === event.itemId))).toEqual([]);
    expect(commandsOf(app)).toHaveLength(5);
    expect(commandsOf(app).every((item) => item.activity?.status === 'unfinished' && item.activity.output === null)).toBe(true);
    expect((made[0] as CodexSession).counts.dropped.oversized).toBe(5);
    // The quotes it was made of are in no item.
    expect(JSON.stringify(app.read(1).items)).not.toContain('""""');
  }, 120_000);

  it('a worker’s item after its turn’s end is filed under the worker, in the turn that started it, and the item that started it ends with the worker', async () => {
    const h = harness = await codexHarness();
    place(h);
    const events: AgentEvent[] = [];
    const app = launch(h, events);
    await turn(app, PROMPTS.outlive);
    // The session's turn is over, and its worker is not: the item that started it is still open.
    const launched = () => done(app).find((item) => item.activity?.type === 'worker');
    await eventually(() => events.some((event) => event.type === 'worker-ended'), 30_000, 'the worker’s end');
    await app.service.settled();
    const turnEnd = events.findIndex((event) => event.type === 'turn-ended');
    const late = events.slice(turnEnd + 1).filter((event) => 'workerId' in event && event.workerId !== undefined && (event.type === 'activity-started' || event.type === 'activity-ended' || event.type === 'message'));
    expect(late.length).toBeGreaterThan(0);
    // Each names the turn that started the worker, which had ended.
    const turnId = of(events, 'turn-started')[0]?.turnId;
    expect(late.every((event) => 'turnId' in event && event.turnId === turnId)).toBe(true);
    const workerId = of(events, 'worker-started')[0]?.workerId ?? '';
    const theirs = app.runtime.readWorker(S(1), workerId);
    expect(theirs).toMatchObject({ status: 'read', workerId, worker: { id: launched()?.id } });
    if (theirs.status !== 'read') return;
    expect(theirs.items.length).toBeGreaterThan(0);
    expect(theirs.items.every((item) => item.workerId === workerId && item.turnId === app.read(1).turns[0]?.id && item.state === 'complete')).toBe(true);
    expect(launched()).toMatchObject({ state: 'complete', activity: { status: 'completed', workerId } });
    // The turn's own end is as it was: nothing of the worker reopened it.
    expect(app.read(1).turns).toMatchObject([{ state: 'ended', outcome: 'completed' }]);
    expect(app.read(1).items.every((item) => item.workerId === null)).toBe(true);
  }, 120_000);
});

// ── M20a, round 3 (K3): a sub-agent a model starts through the `spawnAgent` collab tool ───────
describe('a sub-agent a spawn call starts, through the app (K3; C23, C70–C72)', () => {
  /** K3's prompt: the capture taken on a model that starts a sub-agent by the collab tool, with no `subAgentActivity`. */
  const SPAWN = promptOf('m20a-collab-spawn');

  it('is told by the adapter as a worker with its own item: opened at the call, paired at its completion, ended with the worker’s own turn', async () => {
    const h = harness = await codexHarness();
    const session = start(h);
    session.send(SPAWN);
    expect((await session.ended('turn-1', 60_000)).outcome).toBe('completed');
    for (const event of session.events) expect(AgentEventSchema.safeParse(event).success, event.type).toBe(true);
    const [worker] = of(session.events, 'worker-started');
    const launches = of(session.events, 'activity-started').filter((event) => event.activityType === 'worker');
    expect(launches.map((event) => [event.name, event.pairedWorkerId, typeof event.input])).toEqual([['spawnAgent', undefined, 'string'], ['spawnAgent', worker?.workerId, 'string']]);
    expect(new Set(launches.map((event) => event.itemId)).size).toBe(1);
    const ends = of(session.events, 'activity-ended').filter((event) => event.itemId === launches[0]?.itemId);
    expect(ends).toMatchObject([{ status: 'completed' }]);
    expect(session.events.indexOf(ends[0] as AgentEvent) + 1).toBe(session.events.findIndex((event) => event.type === 'worker-ended'));
    // Before the session's own turn ended: no settle clock is waited out for a closing item that never comes.
    expect(session.types().indexOf('worker-ended')).toBeLessThan(session.types().indexOf('turn-ended'));
    // The one frame of the worker's thread that came before it was known is the only drop.
    expect(counts(session).dropped).toMatchObject({ 'other-thread': 1, 'unopened-item': 0, invalid: 0 });
  }, 90_000);

  it('shows the sub-agent’s row in the session’s chat, under the agent list’s label, and its work under its own id', async () => {
    const h = harness = await codexHarness();
    place(h);
    const events: AgentEvent[] = [];
    const app = launch(h, events);
    await turn(app, SPAWN);
    const workerId = of(events, 'worker-started')[0]?.workerId ?? '';
    // The session's own chat: the item that started the worker, and its wait for it; nothing reads as a second wait.
    const own = done(app).filter((item) => item.activity?.type !== 'thinking');
    expect(own.map((item) => [item.activity?.type, item.activity?.name, item.activity?.status])).toEqual([['worker', 'spawnAgent', 'completed'], ['wait', 'collabAgentToolCall', 'completed']]);
    const launched = own[0];
    expect(launched).toMatchObject({ state: 'complete', workerId: null, activity: { workerId, input: expect.stringContaining('notes-2.txt') as string } });
    expect(launched?.activity?.summary).toBe(app.summary(1)?.agents[0]?.label);
    expect(app.summary(1)).toMatchObject({ status: 'idle', activeWorkers: 0, agents: [{ id: workerId, state: 'completed' }] });
    // The worker's own read and what it said, by its id, in the turn that started it.
    const theirs = app.runtime.readWorker(S(1), workerId);
    expect(theirs).toMatchObject({ status: 'read', workerId, worker: { id: launched?.id } });
    if (theirs.status !== 'read') return;
    const shape = theirs.items.filter((item) => item.activity?.type !== 'thinking').map((item) => (item.kind === 'activity' ? `${item.activity?.type}:${item.activity?.status}` : `${item.role}:${item.phase}:${item.state}`));
    expect(shape).toEqual(['assistant:commentary:complete', 'read:completed', 'assistant:final:complete']);
    expect(theirs.items.every((item) => item.workerId === workerId && item.turnId === app.read(1).turns[0]?.id)).toBe(true);
    expect(theirs.items.find((item) => item.activity?.type === 'read')?.activity).toMatchObject({ summary: 'notes-2.txt', output: expect.stringContaining('kettle') as string });
    expect(app.read(1).items.every((item) => item.workerId === null)).toBe(true);
    // The turn's own answer is the session's, and the last item of its chat.
    expect(app.read(1).items.at(-1)).toMatchObject({ role: 'assistant', phase: 'final' });
  }, 90_000);

  it('fails the row with its worker where the sub-agent’s own turn failed (workerTurnFailed)', async () => {
    const h = harness = await codexHarness();
    place(h);
    h.control({ workerTurnFailed: true });
    const events: AgentEvent[] = [];
    const app = launch(h, events);
    await turn(app, SPAWN);
    expect(of(events, 'worker-ended')).toEqual([expect.objectContaining({ outcome: 'failed' })]);
    expect(done(app).find((item) => item.activity?.type === 'worker')).toMatchObject({ state: 'complete', activity: { status: 'failed' } });
    expect(app.summary(1)?.agents[0]).toMatchObject({ state: 'failed' });
  }, 90_000);
});
