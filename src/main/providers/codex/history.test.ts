// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V16, V17, the adapter's part (docs/planning/_archive/M18.md; C47, C51) and V3 (M20a.md; C19): what a page of `thread/turns/list`
// is taken as, over the replies M15's history capture holds. Each turn keeps Codex's own id, its
// status and its times; each message names its turn, and the user's own the id it was sent with; a
// read that asks for no item answers turns and no message. The same read on a real process, against
// the replay fake, is in tests/codex/isolation.integration.test.ts.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HistoryActivitySchema, HistoryMessageSchema, HistoryPlanSchema, HistoryTurnSchema } from '@shared/contracts/agent-events';
import type { HistoryRequest } from '@shared/provider-kit/sessions';
import { type HistoryConnection, historyActivities, historyMessages, historyPlans, historyTurns, readHistoryPage } from './history';
import { takeHistoryPage, type TakenHistoryPage } from './session-schemas';

interface Frame { readonly index: number; readonly dir: 'send' | 'recv'; readonly frame: { readonly id?: number; readonly method?: string; readonly params?: Record<string, unknown>; readonly result?: unknown } }
interface RawTurn { readonly id: string; readonly status: string; readonly startedAt: number; readonly completedAt: number; readonly durationMs: number; readonly items: readonly { readonly type: string; readonly id: string; readonly clientId?: string }[] }
const CAPTURE = JSON.parse(readFileSync(path.resolve('tests/fixtures/codex/captures/m15-history.json'), 'utf8')) as { frames: Frame[] };

/** The captured reply to the history request with these parameters. */
function captured(limit: number, itemsView: string, cursor = false): { readonly data: readonly RawTurn[]; readonly nextCursor: string | null } {
  const request = CAPTURE.frames.find((f) => f.dir === 'send' && f.frame.method === 'thread/turns/list' && f.frame.params?.['limit'] === limit && f.frame.params['itemsView'] === itemsView && ('cursor' in f.frame.params) === cursor);
  const reply = request === undefined ? undefined : CAPTURE.frames.find((f) => f.dir === 'recv' && f.index > request.index && f.frame.method === undefined && f.frame.id === request.frame.id);
  if (reply === undefined) throw new Error(`the capture has no history request of ${String(limit)} turns, ${itemsView}`);
  return reply.frame.result as { data: RawTurn[]; nextCursor: string | null };
}
const take = (reply: unknown): TakenHistoryPage => {
  const taken = takeHistoryPage(reply);
  if (taken === null) throw new Error('not a page');
  return taken;
};
/** A page of turns made here, for what no capture holds. */
const page = (...turns: Record<string, unknown>[]): TakenHistoryPage => take({ data: turns, nextCursor: null });

describe('a page of history, as the capture holds it (C47, C51)', () => {
  const raw = captured(2, 'full');
  const taken = take(raw);
  /** Oldest first: the capture, as the CLI, holds them newest first. */
  const oldestFirst = [...raw.data].reverse();

  it('keeps each turn’s id, how Codex says it ended and its times, oldest first', () => {
    const turns = historyTurns(taken);
    expect(turns).toHaveLength(2);
    expect(turns).toEqual(oldestFirst.map((turn) => ({ turnId: turn.id, outcome: 'completed', startedAt: turn.startedAt * 1000, endedAt: turn.completedAt * 1000, durationMs: turn.durationMs })));
    for (const turn of turns) expect(HistoryTurnSchema.safeParse(turn).success, turn.turnId).toBe(true);
    // Codex's seconds became milliseconds: a turn's two times are as far apart as its duration, to the second.
    for (const turn of turns) expect(Math.abs((turn.endedAt ?? 0) - (turn.startedAt ?? 0) - (turn.durationMs ?? 0))).toBeLessThan(1000);
    expect((turns[0]?.startedAt ?? 0)).toBeLessThan(turns[1]?.startedAt ?? 0);
  });

  it('names each message’s turn, and gives the user’s own the id it was sent with', () => {
    const messages = historyMessages(taken);
    for (const message of messages) expect(HistoryMessageSchema.safeParse(message).success, message.itemId).toBe(true);
    const expected = oldestFirst.flatMap((turn) => turn.items.filter((item) => item.type === 'userMessage' || item.type === 'agentMessage').map((item) => [turn.id, item.id, item.type === 'userMessage' ? 'user' : 'assistant', item.clientId]));
    expect(messages.map((message) => [message.turnId, message.itemId, message.role, message.clientId])).toEqual(expected);
    expect(messages.map((message) => [message.role, message.phase])).toEqual([['user', null], ['assistant', 'commentary'], ['assistant', 'final'], ['user', null], ['assistant', 'commentary'], ['assistant', 'final']]);
    // The capture's echoes carry one each; an assistant's message has no such key at all.
    const sent = messages.filter((message) => 'clientId' in message);
    expect(sent.map((message) => message.role)).toEqual(['user', 'user']);
    expect(sent.every((message) => typeof message.clientId === 'string' && message.clientId !== '')).toBe(true);
    // `at` is its turn's start, as it was.
    const starts = new Map(historyTurns(taken).map((turn) => [turn.turnId, turn.startedAt]));
    expect(messages.every((message) => message.at === starts.get(message.turnId))).toBe(true);
  });

  it('carries the same turns for a summary and for no items at all', () => {
    const turns = historyTurns(taken);
    expect(historyTurns(take(captured(2, 'summary')))).toEqual(turns);
    expect(historyTurns(take(captured(2, 'notLoaded')))).toEqual(turns);
    expect(historyMessages(take(captured(2, 'notLoaded')))).toEqual([]);
    expect(historyMessages(take(captured(2, 'summary'))).map((message) => [message.turnId, message.role, message.phase])).toEqual(turns.flatMap((turn) => [[turn.turnId, 'user', null], [turn.turnId, 'assistant', 'final']]));
  });
});

describe('a turn’s status and times (C4, C51)', () => {
  it.each([['completed', 'completed'], ['interrupted', 'interrupted'], ['failed', 'failed'], ['inProgress', null], ['somethingNew', null], [null, null], [undefined, null]] as const)('reads the status %s as the outcome %s', (status, outcome) => {
    expect(historyTurns(page({ id: 'turn-a', ...(status === undefined ? {} : { status }), items: [] }))).toEqual([{ turnId: 'turn-a', outcome, startedAt: null, endedAt: null, durationMs: null }]);
  });

  it('gives a time only where Codex gave one: its seconds as whole milliseconds, a duration rounded', () => {
    expect(historyTurns(page({ id: 'turn-a', status: 'completed', startedAt: 1_579_900_008.4, completedAt: null, durationMs: 15_970.6 }))).toEqual([{ turnId: 'turn-a', outcome: 'completed', startedAt: 1_579_900_008_400, endedAt: null, durationMs: 15_971 }]);
    expect(historyTurns(page({ id: 'turn-a', status: 'inProgress', startedAt: 1_579_900_008 }))).toEqual([{ turnId: 'turn-a', outcome: null, startedAt: 1_579_900_008_000, endedAt: null, durationMs: null }]);
    expect(historyTurns(page({ id: 'turn-a', startedAt: 0, completedAt: 0, durationMs: 0 }))[0]).toMatchObject({ startedAt: 0, endedAt: 0, durationMs: 0 });
  });

  it('reads a negative number, and one too large to be a time, as none', () => {
    const [turn] = historyTurns(page({ id: 'turn-a', status: 'completed', startedAt: -1, completedAt: 1e300, durationMs: -0.5 }));
    expect(turn).toEqual({ turnId: 'turn-a', outcome: 'completed', startedAt: null, endedAt: null, durationMs: null });
    expect(HistoryTurnSchema.safeParse(turn).success).toBe(true);
  });

  it('is no page when a turn has no id, or one that is not an id', () => {
    for (const id of [undefined, '', 'x'.repeat(257), 'a\u0000b']) expect(takeHistoryPage({ data: [{ ...(id === undefined ? {} : { id }), items: [] }], nextCursor: null })).toBeNull();
  });
});

// M20a, V3 (C19): the provider's own history gives activity too.
describe('what a turn did, read from history (M20a; C19)', () => {
  const K1 = JSON.parse(readFileSync(path.resolve('tests/fixtures/codex/captures/m20a-steps-tool-on-main.json'), 'utf8')) as { frames: Frame[] };
  const request = K1.frames.find((f) => f.dir === 'send' && f.frame.method === 'thread/turns/list') as Frame;
  const reply = K1.frames.find((f) => f.dir === 'recv' && f.frame.method === undefined && f.frame.id === request.frame.id) as Frame;
  const raw = reply.frame.result as { data: RawTurn[] };
  const taken = take(raw);
  const activities = historyActivities(taken);
  const messages = historyMessages(taken);

  it('maps each command of the turn as a live one is, with the origin’s own id, its turn and its place among the turn’s items', () => {
    const commands = (raw.data[0]?.items ?? []).flatMap((item, place) => (item.type === 'commandExecution' ? [{ id: item.id, place }] : []));
    expect(commands).toHaveLength(4);
    expect(activities.map((activity) => [activity.itemId, activity.order, activity.turnId])).toEqual(commands.map((command) => [command.id, command.place, raw.data[0]?.id]));
    for (const activity of activities) expect(HistoryActivitySchema.safeParse(activity).success, activity.itemId).toBe(true);
    // A read is a read and any other command a command, by its first command action (C14).
    expect(activities.map((activity) => activity.activityType)).toEqual(['command', 'read', 'command', 'command']);
    expect(activities[1]).toMatchObject({ summary: 'README.md', files: [{ path: expect.stringContaining('README.md') as string, line: null }] });
    expect(activities[0]).toMatchObject({ name: 'commandExecution', status: 'completed', exitCode: 0, summary: expect.stringContaining('rg --files') as string, input: expect.stringContaining('rg --files') as string, output: expect.stringContaining('README.md') as string });
  });

  it('gives each its duration where the item has one, a zero included, and no start time of its own: its turn’s alone (K1)', () => {
    expect(activities.every((activity) => typeof activity.durationMs === 'number')).toBe(true);
    expect(activities[0]?.durationMs).toBe(0);
    const [turn] = historyTurns(taken);
    expect(activities.every((activity) => activity.at === turn?.startedAt)).toBe(true);
  });

  it('puts a turn’s messages and activities in one order, by the place each names', () => {
    const all = [...messages.map((message) => [message.order, message.role]), ...activities.map((activity) => [activity.order, activity.activityType])].sort((a, b) => Number(a[0]) - Number(b[0]));
    expect(all.map((entry) => entry[1])).toEqual(['user', 'assistant', 'command', 'read', 'command', 'command', 'assistant']);
    expect(new Set(all.map((entry) => entry[0])).size).toBe(all.length);
  });

  it('returns no checklist: a turn that had five notifications reads back without one (K1; C24)', () => {
    expect(K1.frames.filter((f) => f.dir === 'recv' && f.frame.method === 'turn/plan/updated')).toHaveLength(5);
    expect(activities.some((activity) => activity.activityType === 'checklist')).toBe(false);
    expect((raw.data[0]?.items ?? []).some((item) => item.type === 'plan')).toBe(false);
  });

  // M22 (V21; C76): a declined item is its own status from history too, and no failure — whatever exit code its frame holds.
  it('reads an item still marked in progress as unfinished, a failed one and a non-zero exit code as failed, and a declined one as declined', () => {
    const command = (id: string, extra: Record<string, unknown>) => ({ type: 'commandExecution', id, command: 'x', commandActions: [], ...extra });
    const read = historyActivities(page({ id: 'turn-a', items: [command('a', { status: 'inProgress' }), command('b', { status: 'failed' }), command('c', { status: 'declined' }), command('d', { status: 'completed', exitCode: 2 }), command('e', { status: 'completed', exitCode: 0 }), command('f', { status: 'declined', exitCode: 1 })] }));
    expect(read.map((activity) => activity.status)).toEqual(['unfinished', 'failed', 'declined', 'failed', 'completed', 'declined']);
    expect(read.map((activity) => activity.durationMs)).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
    // History says nothing of who declined it.
    expect(read.every((activity) => !('declinedBy' in activity))).toBe(true);
    for (const activity of read) expect(HistoryActivitySchema.safeParse(activity).success, activity.itemId).toBe(true);
  });

  it('maps a file change, an MCP call, a web search and a reasoning item on a page made from the schema, and no other item type', () => {
    const read = historyActivities(page({ id: 'turn-a', startedAt: 9, items: [
      { type: 'userMessage', id: 'u', content: [{ type: 'text', text: 'q' }] },
      { type: 'fileChange', id: 'f', status: 'completed', changes: [{ path: 'src/a.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@' }] },
      { type: 'mcpToolCall', id: 'm', server: 'docs', tool: 'search', status: 'completed', arguments: { q: 'tides' }, result: { content: [{ type: 'text', text: 'found' }] } },
      { type: 'webSearch', id: 'w', query: 'tide tables' },
      { type: 'reasoning', id: 'r', summary: ['First.', 'Then.'], content: [] },
      { type: 'collabAgentToolCall', id: 'c', tool: 'wait', status: 'completed' },
      { type: 'subAgentActivity', id: 's', kind: 'started', agentThreadId: 'thread-9' },
      { type: 'plan', id: 'p', text: 'a plan' },
      { type: 'agentMessage', id: 'a', text: 'done', phase: 'final_answer' },
    ] }));
    expect(read.map((activity) => [activity.itemId, activity.activityType, activity.order])).toEqual([['f', 'edit', 1], ['m', 'mcp', 2], ['w', 'web-search', 3], ['r', 'thinking', 4]]);
    expect(read[0]).toMatchObject({ summary: 'a.ts', changes: [{ path: 'src/a.ts', kind: 'update', text: '@@ -1 +1 @@' }], files: [{ path: 'src/a.ts', line: null }] });
    expect(read[1]).toMatchObject({ name: 'docs: search', summary: 'docs: search', output: 'found' });
    expect(read[1]?.input).toContain('"q": "tides"');
    expect(read[2]).toMatchObject({ summary: 'tide tables', input: 'tide tables' });
    expect(read[3]).toMatchObject({ thinking: 'First.\n\nThen.', at: 9_000 });
    for (const activity of read) expect(HistoryActivitySchema.safeParse(activity).success, activity.itemId).toBe(true);
  });

  it('answers activities with the items of a full read alone: a summary and a listing have none', async () => {
    const wire = { ready: () => true, droppedLines: () => 0, onDropped: () => () => undefined, ask: () => Promise.resolve(raw) };
    const read = (detail: HistoryRequest['detail']) => readHistoryPage(wire, 'thread-1', { cursor: null, size: 1, detail }, new AbortController().signal);
    expect(await read('full')).toMatchObject({ kind: 'page', activities });
    for (const detail of ['summary', 'none'] as const) {
      const answer = await read(detail);
      expect(answer.kind === 'page' && 'activities' in answer).toBe(false);
    }
  });
});

// M21, V5, V20 (C28, C56, C69): K2's history read, taken from a second process that never resumed the thread.
describe('a question asked in a message, read back (M21; C28, C56, C69)', () => {
  interface AskedItem { readonly type: string; readonly id: string; readonly text?: string; readonly questions?: unknown }
  const K2 = JSON.parse(readFileSync(path.resolve('tests/fixtures/codex/captures/m21-codex-history.json'), 'utf8')) as { frames: Frame[] };
  const request = K2.frames.find((f) => f.dir === 'send' && f.frame.method === 'thread/turns/list') as Frame;
  const reply = K2.frames.find((f) => f.dir === 'recv' && f.frame.method === undefined && f.frame.id === request.frame.id) as Frame;
  const raw = reply.frame.result as { data: (RawTurn & { items: readonly AskedItem[] })[] };
  const taken = take(raw);
  const oldestFirst = [...raw.data].reverse();
  const messages = historyMessages(taken);
  /** The empty message a turn that asks in a message ends with. */
  const isEmpty = (item: AskedItem): boolean => item.type === 'agentMessage' && item.text === '' && item.questions === null;

  it('holds the five turns K2 ran, and nothing of the request two of them were asked through: a blocking question is in no history read', () => {
    expect(historyTurns(taken).map((turn) => turn.outcome)).toEqual(['completed', 'interrupted', 'completed', 'completed', 'completed']);
    // The answered plan turn is its prompt and its plan; the interrupted one its prompt alone.
    expect(oldestFirst.map((turn) => turn.items.map((item) => item.type))).toEqual([['userMessage', 'plan'], ['userMessage'], ['userMessage', 'agentMessage', 'agentMessage'], ['userMessage', 'agentMessage', 'commandExecution', 'agentMessage'], ['userMessage', 'agentMessage', 'agentMessage']]);
    expect(messages.filter((message) => message.turnId === oldestFirst[0]?.id || message.turnId === oldestFirst[1]?.id).map((message) => message.role)).toEqual(['user', 'user']);
    // A plan is no activity history is read for, as before.
    expect(historyActivities(taken).map((activity) => activity.activityType)).toEqual(['read']);
  });

  it('keeps a message’s questions as the conversation text they are, the one with one and the one with two', () => {
    const asking = messages.filter((message) => message.questions !== undefined);
    expect(asking.map((message) => message.questions)).toEqual([
      [{ title: 'Which file do you want me to read?', options: ['notes-1.txt', 'notes-2.txt'] }],
      [{ title: 'Which file do you want me to read?', options: ['notes-1.txt', 'notes-2.txt'] }, { title: 'Would you like it quoted or summarised?', options: ['Quoted', 'Summarised'] }],
    ]);
    expect(asking.every((message) => message.role === 'assistant' && message.phase === 'final' && message.text.includes('notes-1.txt'))).toBe(true);
    for (const message of messages) expect(HistoryMessageSchema.safeParse(message).success, message.itemId).toBe(true);
  });

  it('gives no message for the empty one after each: what the live path lets go, the merge must never add', () => {
    const empty = raw.data.flatMap((turn) => turn.items.filter(isEmpty).map((item) => item.id));
    expect(empty).toHaveLength(2);
    expect(messages.filter((message) => empty.includes(message.itemId))).toEqual([]);
    expect(messages.some((message) => message.role === 'assistant' && message.text === '')).toBe(false);
    // Each asking turn reads as its prompt and its question, and the turn that answered one as it was.
    expect(oldestFirst.map((turn) => messages.filter((message) => message.turnId === turn.id).map((message) => message.role))).toEqual([['user'], ['user'], ['user', 'assistant'], ['user', 'assistant', 'assistant'], ['user', 'assistant']]);
    // Every other message keeps its place among its turn's items: the one left out leaves no one's changed.
    for (const turn of raw.data) for (const message of messages.filter((entry) => entry.turnId === turn.id)) expect(turn.items[message.order ?? -1]?.id).toBe(message.itemId);
  });

  it('leaves out exactly that shape: a message with questions and no text, and one with any text, are messages', () => {
    const agent = (id: string, text: string, questions: unknown = null) => ({ type: 'agentMessage', id, text, phase: 'final_answer', questions });
    const read = historyMessages(page({ id: 'turn-a', items: [agent('a', ''), agent('b', '', [{ title: 'Which?', options: ['one', 'two'] }]), agent('c', ' '), agent('d', 'Done.'), agent('e', '', [])] }));
    expect(read.map((message) => [message.itemId, message.order])).toEqual([['b', 1], ['c', 2], ['d', 3]]);
    expect(read[0]?.questions).toEqual([{ title: 'Which?', options: ['one', 'two'] }]);
  });
});

// M22b, V3 (C28): K2's history read on codex-cli 0.163.0, of the thread its `history` run planned on.
describe('a plan read back (M22b, C28)', () => {
  interface PlanRaw { readonly type: string; readonly id: string; readonly text?: string }
  const K2 = JSON.parse(readFileSync(path.resolve('tests/fixtures/codex/captures/m22b-codex-history.json'), 'utf8')) as { frames: Frame[] };
  const request = K2.frames.find((f) => f.dir === 'send' && f.frame.method === 'thread/turns/list') as Frame;
  const reply = K2.frames.find((f) => f.dir === 'recv' && f.frame.method === undefined && f.frame.id === request.frame.id) as Frame;
  const raw = reply.frame.result as { data: (RawTurn & { items: readonly PlanRaw[] })[] };
  const taken = take(raw);
  const oldestFirst = [...raw.data].reverse();
  const planned = oldestFirst.flatMap((turn) => (turn.items as readonly PlanRaw[]).flatMap((item, place) => (item.type === 'plan' ? [{ turnId: turn.id, itemId: item.id, text: item.text ?? '', at: turn.startedAt * 1000, order: place }] : [])));

  it('gives each plan item its turn, its place among the turn’s items and its whole text, oldest first', () => {
    expect(planned).toHaveLength(1);
    expect(historyPlans(taken)).toEqual(planned);
    for (const plan of historyPlans(taken)) expect(HistoryPlanSchema.safeParse(plan).success).toBe(true);
    expect(planned[0]?.text).toMatch(/^## Append/);
  });

  it('makes it neither a message nor an activity: the merge says what it is', () => {
    const ids = new Set(planned.map((plan) => plan.itemId));
    expect(historyMessages(taken).filter((message) => ids.has(message.itemId))).toEqual([]);
    expect(historyActivities(taken).filter((activity) => ids.has(activity.itemId))).toEqual([]);
    // The plan turn's prompt is a message as any is.
    expect(historyMessages(taken).filter((message) => message.turnId === planned[0]?.turnId).map((message) => message.role)).toEqual(['user']);
  });

  it('answers plans with a turn’s messages — a full read and a summary — and none with a listing', async () => {
    const wire = { ready: () => true, droppedLines: () => 0, onDropped: () => () => undefined, ask: () => Promise.resolve(raw) };
    const read = (detail: HistoryRequest['detail']) => readHistoryPage(wire, 'thread-1', { cursor: null, size: 20, detail }, new AbortController().signal);
    for (const detail of ['full', 'summary'] as const) expect(await read(detail)).toMatchObject({ kind: 'page', plans: planned });
    const listing = await read('none');
    expect(listing.kind === 'page' && 'plans' in listing).toBe(false);
  });

  it('reads a plan item with no text as an empty one, and drops one with no id', () => {
    const turn = { id: 'turn-1', status: 'completed', items: [{ type: 'plan', id: 'plan-1' }, { type: 'plan', text: 'lost' }, { type: 'plan', id: 'plan-2', text: null }] };
    expect(historyPlans(page(turn)).map((plan) => [plan.itemId, plan.text, plan.order])).toEqual([['plan-1', '', 0], ['plan-2', '', 2]]);
  });
});

describe('the id a user’s message was sent with (C47)', () => {
  const user = (clientId?: unknown) => ({ type: 'userMessage', id: 'item-u', ...(clientId === undefined ? {} : { clientId }), content: [{ type: 'text', text: 'Hello.' }] });

  it('is carried when the CLI kept one, and left out when it kept none or one that is not an id', () => {
    expect(historyMessages(page({ id: 'turn-a', items: [user('message-1')] }))).toEqual([{ role: 'user', itemId: 'item-u', phase: null, text: 'Hello.', turnId: 'turn-a', clientId: 'message-1', at: null, order: 0 }]);
    for (const clientId of [undefined, null, '', 'x'.repeat(257), 'a\u0000b']) {
      const [message] = historyMessages(page({ id: 'turn-a', items: [user(clientId)] }));
      expect(message).toEqual({ role: 'user', itemId: 'item-u', phase: null, text: 'Hello.', turnId: 'turn-a', at: null, order: 0 });
      expect(HistoryMessageSchema.safeParse(message).success).toBe(true);
    }
  });
});

describe('one read (C51)', () => {
  /** A connection that is up, and answers every request with `reply`. */
  function connection(reply: unknown): HistoryConnection & { readonly asked: { method: string; params: unknown }[] } {
    const asked: { method: string; params: unknown }[] = [];
    return { asked, ready: () => true, droppedLines: () => 0, onDropped: () => () => undefined, ask: (method, params) => { asked.push({ method, params }); return Promise.resolve(reply); } };
  }
  const read = (wire: HistoryConnection, request: HistoryRequest) => readHistoryPage(wire, 'thread-1', request, new AbortController().signal);

  it('answers a page’s turns and messages, both oldest first, each message naming a turn of the page, and the cursor', async () => {
    const raw = captured(1, 'full');
    const wire = connection(raw);
    const answer = await read(wire, { cursor: null, size: 1, detail: 'full' });
    expect(wire.asked).toEqual([{ method: 'thread/turns/list', params: { threadId: 'thread-1', limit: 1, itemsView: 'full' } }]);
    if (answer.kind !== 'page') throw new Error(answer.kind);
    // With its activities (M20a, C19): the turn ran a command between its messages.
    expect(Object.keys(answer).sort()).toEqual(['activities', 'kind', 'messages', 'next', 'turns']);
    expect(answer.activities?.every((activity) => activity.turnId === answer.turns[0]?.turnId)).toBe(true);
    expect(answer.turns.map((turn) => turn.turnId)).toEqual([raw.data[0]?.id]);
    expect(answer.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(answer.messages.every((message) => message.turnId === answer.turns[0]?.turnId)).toBe(true);
    expect(answer.next).toBe(raw.nextCursor);
    expect(typeof answer.next).toBe('string');
  });

  it('asks for no item with `detail: none`, and answers turns and no message', async () => {
    const wire = connection(captured(1, 'notLoaded'));
    const answer = await read(wire, { cursor: 'older', size: 1, detail: 'none' });
    expect(wire.asked).toEqual([{ method: 'thread/turns/list', params: { threadId: 'thread-1', limit: 1, itemsView: 'notLoaded', cursor: 'older' } }]);
    expect(answer).toMatchObject({ kind: 'page', messages: [] });
    expect(answer.kind === 'page' && answer.turns).toHaveLength(1);
    expect(answer.kind === 'page' && HistoryTurnSchema.safeParse(answer.turns[0]).success).toBe(true);
  });

  it('answers no message to a read that asked for none, whatever came with the turns', async () => {
    const answer = await read(connection(captured(2, 'full')), { cursor: null, size: 2, detail: 'none' });
    expect(answer).toMatchObject({ kind: 'page', messages: [], next: null });
    expect(answer.kind === 'page' && answer.turns).toHaveLength(2);
  });

  it('fails on a reply that is no page', async () => {
    expect(await read(connection({ data: 'nothing' }), { cursor: null, size: 8, detail: 'full' })).toEqual({ kind: 'failed' });
  });
});

// M23, V5 (C24, C25): a user's message's images in Codex's history, by the paths it was sent with.
describe('a user’s images in the history (M23: V5; C24, C25)', () => {
  it('keeps each localImage part’s path, in order, as received, and reads none of them', () => {
    const read = historyMessages(page({ id: 'turn-i', startedAt: 9, items: [
      { type: 'userMessage', id: 'u', clientId: 'client-1', content: [{ type: 'text', text: 'Look', text_elements: [] }, { type: 'localImage', detail: null, path: 'C:\\data\\attachments\\a.png' }, { type: 'localImage', detail: null, path: 'D:\\elsewhere\\b.png' }] },
      { type: 'agentMessage', id: 'a', text: 'Red and blue.', phase: 'final_answer' },
    ] }));
    expect(read[0]).toMatchObject({ role: 'user', text: 'Look', images: [{ path: 'C:\\data\\attachments\\a.png' }, { path: 'D:\\elsewhere\\b.png' }] });
    expect(read[1]).not.toHaveProperty('images');
    for (const message of read) expect(HistoryMessageSchema.safeParse(message).success).toBe(true);
  });

  it('leaves out a path that is empty, too long or holds a control character, and takes a message of images alone', () => {
    const read = historyMessages(page({ id: 'turn-j', startedAt: 9, items: [
      { type: 'userMessage', id: 'u', content: [{ type: 'localImage', path: '' }, { type: 'localImage', path: `C:\\${'x'.repeat(5000)}.png` }, { type: 'localImage', path: 'C:\\a\u0000b.png' }, { type: 'localImage', path: 'C:\\ok.png' }] },
    ] }));
    expect(read[0]).toMatchObject({ role: 'user', text: '', images: [{ path: 'C:\\ok.png' }] });
  });
});
