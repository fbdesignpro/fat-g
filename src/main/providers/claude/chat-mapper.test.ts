// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V13, V30, V33, V38 (docs/planning/_archive/M16.md, Design 5; C31–C41, C70, C74–C77, C83, C87): the frame
// mapping, table-driven per capture. Each capture's frames go through the mapper as the session
// feeds them: a prompt fat-g wrote begins a turn, an interrupt it sent marks the turn stopped, and
// a reply to a request of fat-g's never reaches the mapper at all.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type AgentEvent, AgentEventSchema, MAX_MESSAGE_TEXT, MAX_NOTICE_DETAIL } from '@shared/contracts/agent-events';
import { MAX_LINE_INPUT } from '@shared/contracts/sessions';
import { frameKind, refusedSubtype, REQUEST_SUBTYPES, takeRequest } from './chat-frames';
import { CLAUDE_MODES, READING_MODE } from './chat-modes';
import { foldDeltas } from '../../../../tests/sessions/facet-contract';
import { approvalDecided, approvalReleased, beginChatTurn, type ChatMapperEffect, type ChatMapperState, endFailure, expireWaitingFrames, failChatWorkers, mapChatFrame, MAX_WAITING_FRAMES, newChatMapper, placeApproval, type PlacedQuestion, type PlacedRequest, placeQuestion, questionAnswered, questionReleased } from './chat-mapper';

type Json = Record<string, unknown>;
interface Frame { readonly index: number; readonly dir: 'send' | 'recv'; readonly frame: Json }
const load = (name: string): Frame[] => (JSON.parse(readFileSync(path.resolve('tests/fixtures/claude/captures', `${name}.json`), 'utf8')) as { frames: Frame[] }).frames;
const at = (value: unknown, ...keys: (string | number)[]): unknown => keys.reduce<unknown>((current, key) => (current !== null && typeof current === 'object' ? (current as Record<string | number, unknown>)[key] : undefined), value);
const FOLDER = 'D:\\Code\\fat-g';
const RUNTIME = (n: number): string => `runtime-turn-${n}`;

type End = Extract<ChatMapperEffect, { type: 'turn-ended' }>;
interface Played {
  readonly events: AgentEvent[];
  readonly effects: ChatMapperEffect[];
  readonly drops: string[];
  unread: number;
  /** Events and ends, in the order they came: an end as `end:<outcome>`. */
  readonly order: string[];
  readonly state: ChatMapperState;
  ends(): End[];
}

interface PlayOptions {
  /** Edits or withholds a received frame first. */
  readonly change?: (frame: Json, index: number) => Json | null;
  /** The record holds the reference already: a resumed session. */
  readonly referenced?: boolean;
  /** Goes on in the state another capture left: the same process's next turn. */
  readonly state?: ChatMapperState;
  /** The first turn's number, for a second capture on one state. */
  readonly firstTurn?: number;
  /** Stops after the frame with this index. */
  readonly until?: number;
}

/**
 * What M20a added to what a session tells: its activities, and everything that names a worker as
 * its owner. It goes to the chat alone (C30), beside what M16 and M19 map, which the tests of those
 * milestones speak of by `order`, `messages` and `told`; the M20a tests at the foot speak of this.
 */
const isWork = (event: AgentEvent): boolean => event.type === 'activity-started' || event.type === 'activity-ended' || ((event.type === 'message' || event.type === 'message-delta') && event.workerId !== undefined);

function feed(played: Played, frame: unknown): void {
  const mapped = mapChatFrame(played.state, frame);
  played.events.push(...mapped.events);
  played.effects.push(...mapped.effects);
  played.order.push(...mapped.events.filter((event) => !isWork(event) && event.type !== 'action-changed' && event.type !== 'worker-progressed').map((event) => (event.type === 'notice' ? `notice:${event.kind}` : event.type)), ...mapped.effects.flatMap((effect) => (effect.type === 'turn-ended' ? [`end:${effect.outcome}`] : effect.type === 'overruled' ? ['overruled'] : [])));
  if (mapped.drop !== null) played.drops.push(mapped.drop);
  if (mapped.unread) played.unread += 1;
}

const blank = (state: ChatMapperState): Played => ({ events: [], effects: [], drops: [], unread: 0, order: [], state, ends() { return this.effects.filter((effect): effect is End => effect.type === 'turn-ended'); } });

/** A capture's frames, in their order, as the session meets them. */
function play(name: string, options: PlayOptions = {}): Played {
  const played = blank(options.state ?? newChatMapper(FOLDER, options.referenced === true));
  let turn = (options.firstTurn ?? 1) - 1;
  for (const entry of load(name)) {
    if (options.until !== undefined && entry.index > options.until) break;
    const { frame } = entry;
    if (entry.dir === 'send') {
      // What fat-g sends changes the mapping state, as the session changes it.
      if (frame['type'] === 'user' && typeof frame['uuid'] === 'string') beginChatTurn(played.state, RUNTIME(++turn), frame['uuid']);
      if (frame['type'] === 'control_request' && at(frame, 'request', 'subtype') === 'interrupt' && played.state.turn !== null) played.state.turn.stopped = true;
      continue;
    }
    // The connection takes the replies to fat-g's own requests: they are no frame of the session's.
    if (frame['type'] === 'control_response') continue;
    const changed = options.change === undefined ? frame : options.change(frame, entry.index);
    if (changed !== null) feed(played, changed);
  }
  return played;
}

/** The session's own messages: a worker's name their worker (M20a, C20). */
const messages = (played: Played) => played.events.flatMap((event) => (event.type === 'message' && event.workerId === undefined ? [event] : []));
/** What a session tells apart from its work: what M16 and M19 map. */
const told = (played: Played): AgentEvent[] => played.events.filter((event) => !isWork(event));
const starts = (played: Played) => played.events.flatMap((event) => (event.type === 'activity-started' ? [event] : []));
const ends = (played: Played) => played.events.flatMap((event) => (event.type === 'activity-ended' ? [event] : []));
const actions = (played: Played) => played.events.flatMap((event) => (event.type === 'action-changed' ? [event] : []));
const ofType = <T extends AgentEvent['type']>(played: Played, type: T) => played.events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type);
const valid = (played: Played): void => { for (const event of played.events) expect(AgentEventSchema.safeParse(event).success, JSON.stringify(event).slice(0, 120)).toBe(true); };
const isInit = (frame: Json): boolean => frame['type'] === 'system' && frame['subtype'] === 'init';
const isResult = (frame: Json): boolean => frame['type'] === 'result';

describe('T1, a basic turn (V33)', () => {
  const played = play('m16-t1-basic');

  it('emits only events that pass the schema, each naming the runtime’s turn, in the order the frames came', () => {
    valid(played);
    for (const event of played.events) if ('turnId' in event) expect(event.turnId).toBe(RUNTIME(1));
    expect(played.order).toEqual(['turn-started', 'in-force', 'session-started', 'message', 'end:completed']);
    expect(played.drops).toEqual([]);
  });

  it('bounds the turn by the `command_lifecycle` frames that name its prompt’s id: `started` says Claude took it, and the closing frame is expected (C31, C75)', () => {
    // No id of the provider's for the turn: Claude names none.
    expect(played.events[0]).toEqual({ type: 'turn-started', turnId: RUNTIME(1) });
    expect(played.effects.map((effect) => effect.type)).toEqual(['started', 'turn-ended']);
    // `queued`, and `completed` after the `result`, change nothing and are not counted.
    expect(played.state.turn).toMatchObject({ started: true, inited: true, ended: true, closed: true });
    // The frames of another id are no part of it.
    const other = play('m16-t1-basic', { change: (frame) => (frame['type'] === 'command_lifecycle' ? { ...frame, command_uuid: 'someone-else' } : frame) });
    expect(other.events).toEqual([]);
    // One more than before M20a: the read's result, a frame of no turn as the rest are.
    expect(other.drops).toEqual(['other-turn', 'other-turn', 'other-turn', 'other-turn', 'other-turn', 'other-turn', 'other-turn', 'other-turn']);
  });

  it('reports the model its `init` names, and nothing else of that frame (C32, C33)', () => {
    expect(ofType(played, 'in-force')).toEqual([{ type: 'in-force', turnId: RUNTIME(1), model: 'claude-sonnet-5' }]);
    const text = JSON.stringify(played.events);
    for (const absent of ['mcp__', 'apiKeySource', 'memory_paths', 'messaging_socket', '<socket>', 'powershell', 'claude_code_version', 'slash_commands']) expect(text, absent).not.toContain(absent);
  });

  it('shows a read as the reading action with the file’s name, never its path (C38)', () => {
    expect(actions(played)[0]).toEqual({ type: 'action-changed', turnId: RUNTIME(1), kind: 'reading', file: 'sample.txt' });
    // Nothing that reaches the summary holds the path: it is the read's own, for the chat alone (M20a, C8, C30).
    expect(JSON.stringify(told(played))).not.toContain('<scratch>\\\\sample.txt');
    expect(starts(played)).toMatchObject([{ activityType: 'read', files: [{ path: '<scratch>\\sample.txt', line: null }] }]);
  });

  it('reports its text as it arrives, as commentary under the frame’s own id, and names it as the answer on the completed end (C35, C74, C77)', () => {
    expect(messages(played)).toEqual([{ type: 'message', turnId: RUNTIME(1), role: 'assistant', itemId: '<uuid-13>', phase: 'commentary', text: 'The cat is called Biscuit.' }]);
    expect(actions(played)[1]).toEqual({ type: 'action-changed', turnId: RUNTIME(1), kind: 'thinking' });
    expect(played.ends()).toEqual([{ type: 'turn-ended', outcome: 'completed', answerItemId: '<uuid-13>', lost: false, detail: null }]);
    expect(endFailure(played.ends()[0] as End)).toBeUndefined();
    // Reported while its `result` is held back, as a Stop hook holds it (C70): the message is there before that frame comes.
    const held = play('m16-t1-basic', { until: 9 });
    expect(messages(held)).toHaveLength(1);
    expect(held.ends()).toEqual([]);
    expect(held.state.turn).toMatchObject({ ended: false, lastText: '<uuid-13>' });
  });

  it('never parses the frames it does not read: a rate limit, a hook’s — and of a `user` frame reads its tool results alone (M20a, C18)', () => {
    // The rate limit alone: the read's result is read now, for its activity's end.
    expect(played.unread).toBe(1);
    expect(JSON.stringify(told(played))).not.toContain('lighthouse');
    // Of a `user` frame: its type, whose it is, and its message's content. `tool_use_result` and `tool_result_meta` are never looked at.
    const read: string[] = [];
    const guarded = new Proxy({ type: 'user', message: { content: 'private' }, tool_use_result: { file: 'private' }, tool_result_meta: { private: true } }, { get: (target, key) => { read.push(String(key)); return (target as Json)[String(key)]; } });
    const state = newChatMapper(FOLDER, false);
    // With no tool result in it — a prompt's echo, an interrupt's mark — it is not read, as before.
    expect(mapChatFrame(state, guarded)).toEqual({ events: [], effects: [], drop: null, unread: true });
    expect([...new Set(read)].sort()).toEqual(['message', 'parent_tool_use_id', 'type']);
    for (const frame of [{ type: 'rate_limit_event' }, { type: 'system', subtype: 'hook_started' }, { type: 'system', subtype: 'background_tasks_changed' }, { type: 'keep_alive' }, 'a string', null, 7, []]) expect(frameKind(frame), JSON.stringify(frame)).toBe('unread');
  });
});

describe('T3, a worker (V33)', () => {
  const played = play('m16-t3-subagent');
  const worker = '<worker-12>';

  it('reports the commentary when it arrives, before the tool call it announces, each text under its frame’s own id', () => {
    valid(played);
    expect(played.order).toEqual([
      'turn-started', 'in-force', 'session-started', 'message', 'worker-started', 'worker-model', 'worker-ended', 'message', 'end:completed',
    ]);
    expect(messages(played).map((message) => [message.itemId, message.phase, message.text])).toEqual([
      ['<uuid-8>', 'commentary', 'I\'ll delegate this to a sub-agent to read the file.'],
      ['<uuid-25>', 'commentary', 'The sub-agent found that notes-3.txt contains: "Note three: the logbook is kept in the blue drawer."'],
    ]);
    // The last text is the answer; the first stays what it was said as.
    expect(played.ends()).toEqual([{ type: 'turn-ended', outcome: 'completed', answerItemId: '<uuid-25>', lost: false, detail: null }]);
  });

  it('shows both texts of one reply when they share a message id: the item id is the frame’s (C77)', () => {
    const shared = play('m16-t3-subagent', { change: (frame) => (frame['type'] === 'assistant' ? { ...frame, message: { ...(frame['message'] as Json), id: '<message-7>' } } : frame) });
    expect(messages(shared).map((message) => message.itemId)).toEqual(['<uuid-8>', '<uuid-25>']);
    expect(new Set(messages(shared).map((message) => message.itemId)).size).toBe(2);
  });

  it('labels the waiting action with the turn’s latest commentary, and never a tool’s input (C38)', () => {
    expect(actions(played).map((event) => [event.kind, event.line])).toEqual([
      ['waiting', 'I\'ll delegate this to a sub-agent to read the file.'],
      ['waiting', 'I\'ll delegate this to a sub-agent to read the file.'],
      ['thinking', undefined],
    ]);
    expect(JSON.stringify(actions(played))).not.toContain('report back its full contents');
  });

  it('opens the worker by its task id with its description, gives its action by the tool it names, and ends it once (C39)', () => {
    // With the agent definition `task_started` names (M106, C20); the worker's frames name the session's model, for the list (C14).
    expect(ofType(played, 'worker-started')).toEqual([{ type: 'worker-started', workerId: worker, description: 'Read notes-3.txt contents', agentType: 'general-purpose' }]);
    expect(ofType(played, 'worker-model')).toEqual([{ type: 'worker-model', workerId: worker, model: 'claude-sonnet-5' }]);
    expect(ofType(played, 'worker-progressed')).toEqual([{ type: 'worker-progressed', workerId: worker, kind: 'reading', file: 'notes-3.txt' }, { type: 'worker-progressed', workerId: worker, kind: 'thinking' }]);
    // `task_updated` ends it; the `task_notification` that follows ends it no second time.
    expect(ofType(played, 'worker-ended')).toEqual([{ type: 'worker-ended', workerId: worker, outcome: 'completed' }]);
    expect(played.state.workers.size).toBe(0);
  });

  it('has no text of the worker’s, and nothing of its prompt, in anything the summary or the session’s own messages are told (C34, C39)', () => {
    const text = JSON.stringify(told(played));
    // The agent definition is told, by fat-g's own name for it (M106, C20): never the CLI's key, nor anything else of `task_started`.
    for (const absent of ['report back its full contents verbatim', 'The contents of notes-3.txt', 'agentId', 'output_file', 'subagent_type']) expect(text, absent).not.toContain(absent);
    // The worker's own frames are no message and no action of the session's, and are not counted as dropped.
    expect(played.drops).toEqual([]);
    expect(messages(played)).toHaveLength(2);
    // Never, in any event: where the CLI keeps the worker's output, and its own bookkeeping.
    for (const absent of ['output_file', 'tool_use_result']) expect(JSON.stringify(played.events), absent).not.toContain(absent);
    // The result's own `agentType` is never read: the one the events carry is `task_started`'s (M106, C20).
    expect(played.events.filter((event) => JSON.stringify(event).includes('agentType')).map((event) => event.type)).toEqual(['worker-started', 'activity-started']);
  });
});

describe('T4, a Stop (V33)', () => {
  const played = play('m16-t4-interrupt');

  it('ends interrupted by the CLI’s own `result`, closed by `cancelled`, with no answer named', () => {
    valid(played);
    expect(played.order).toEqual(['turn-started', 'in-force', 'session-started', 'end:interrupted']);
    expect(played.ends()).toEqual([{ type: 'turn-ended', outcome: 'interrupted', answerItemId: null, lost: false, detail: null }]);
    expect(played.state.turn).toMatchObject({ ended: true, closed: true, stopped: true });
    expect(played.drops).toEqual([]);
  });

  it('keeps the interrupt’s marker out of the chat, and the rejected tool’s words out of its messages: they are that tool’s own result (C34; M20a, C18)', () => {
    expect(messages(played)).toEqual([]);
    // The marker is a text block of a `user` frame, which makes no message and is not read.
    expect(JSON.stringify(played.events)).not.toContain('Request interrupted by user');
    const text = JSON.stringify(told(played));
    for (const absent of ['Request interrupted by user', 'doesn\'t want to proceed']) expect(text, absent).not.toContain(absent);
    // The tool the Stop rejected failed, as its result says.
    expect(ends(played)).toMatchObject([{ status: 'failed', output: expect.stringContaining('doesn\'t want to proceed') as string }]);
  });

  it('fails the same turn when no Stop was sent: the `result` is an error either way (C36)', () => {
    const state = newChatMapper(FOLDER, false);
    const unstopped = blank(state);
    for (const entry of load('m16-t4-interrupt')) {
      if (entry.dir === 'send') { if (entry.frame['type'] === 'user') beginChatTurn(state, RUNTIME(1), String(entry.frame['uuid'])); continue; }
      if (entry.frame['type'] !== 'control_response') feed(unstopped, entry.frame);
    }
    expect(unstopped.ends()).toEqual([{ type: 'turn-ended', outcome: 'failed', answerItemId: null, lost: false, detail: null }]);
    expect(endFailure(unstopped.ends()[0] as End)).toBe('turn-failed');
  });
});

describe('T5, a failure (V33)', () => {
  const played = play('m16-t5-error');
  const words = 'There\'s an issue with the selected model (m10-no-such-model). It may not exist or you may not have access to it. Run --model to pick a different model.';

  it('ends failed with the CLI’s own text as the detail, though its `result` reads `success`, and shows no message (C36, C37)', () => {
    valid(played);
    expect(played.order).toEqual(['turn-started', 'in-force', 'end:failed']);
    expect(played.ends()).toEqual([{ type: 'turn-ended', outcome: 'failed', answerItemId: null, lost: false, detail: words }]);
    expect(endFailure(played.ends()[0] as End)).toBe('turn-failed');
    expect(messages(played)).toEqual([]);
    expect(at(load('m16-t5-error').find((entry) => isResult(entry.frame))?.frame, 'subtype')).toBe('success');
  });

  it('reports no reference: the CLI answered by itself, and no model did (C87)', () => {
    expect(ofType(played, 'session-started')).toEqual([]);
    expect(played.state).toMatchObject({ referenced: false, sessionId: '<session-1>' });
  });

  it('drops the rate limit that comes after the closing frame, unparsed and counted', () => {
    expect(played.unread).toBe(1);
    expect(played.drops).toEqual([]);
  });

  it('cuts a longer text of the CLI’s to the detail’s bound', () => {
    const long = play('m16-t5-error', { change: (frame) => (frame['type'] === 'assistant' ? { ...frame, message: { ...(frame['message'] as Json), content: [{ type: 'text', text: 'x'.repeat(MAX_NOTICE_DETAIL + 300) }] } } : frame) });
    expect(long.ends()[0]?.detail).toHaveLength(MAX_NOTICE_DETAIL);
    // A failed turn without such a frame has fat-g's words alone.
    const bare = play('m16-t5-error', { change: (frame) => (frame['type'] === 'assistant' ? null : frame) });
    expect(bare.ends()).toEqual([{ type: 'turn-ended', outcome: 'failed', answerItemId: null, lost: false, detail: null }]);
  });
});

describe('a prompt that names a command (V27, V33; C69)', () => {
  const played = play('m16-command-refused');

  it('shows the CLI’s own answer as the turn’s message, and completes', () => {
    valid(played);
    expect(played.order).toEqual(['turn-started', 'in-force', 'message', 'end:completed']);
    expect(messages(played)).toEqual([{ type: 'message', turnId: RUNTIME(1), role: 'assistant', itemId: '<uuid-7>', phase: 'commentary', text: '/model isn\'t available in this environment.' }]);
    expect(played.ends()).toEqual([{ type: 'turn-ended', outcome: 'completed', answerItemId: '<uuid-7>', lost: false, detail: null }]);
  });

  it('reports no reference for it: no model answered (C87)', () => {
    expect(ofType(played, 'session-started')).toEqual([]);
  });
});

describe('K22, a Stop before `init` (V11, V30)', () => {
  const played = play('m16-chat-early-interrupt');

  it('is bounded as any turn: Claude took the prompt, and the interrupted end is the CLI’s own', () => {
    valid(played);
    expect(played.order).toEqual(['turn-started', 'in-force', 'end:interrupted']);
    expect(played.ends()).toEqual([{ type: 'turn-ended', outcome: 'interrupted', answerItemId: null, lost: false, detail: null }]);
    expect(messages(played)).toEqual([]);
    expect(ofType(played, 'session-started')).toEqual([]);
    expect(played.drops).toEqual([]);
  });
});

describe('K23, a request from the CLI (V33)', () => {
  const played = play('m16-chat-request');

  it('maps the turn around the request, which is the session’s to answer, to its completed end', () => {
    valid(played);
    expect(played.order).toEqual(['turn-started', 'in-force', 'session-started', 'message', 'end:completed']);
    expect(actions(played)[0]).toMatchObject({ kind: 'reading', file: 'second.txt' });
    expect(played.ends()[0]).toMatchObject({ outcome: 'completed', answerItemId: '<uuid-14>' });
    // The request itself: no event of the mapper's, and nothing of the path it names.
    const request = load('m16-chat-request').find((entry) => entry.dir === 'recv' && entry.frame['type'] === 'control_request')?.frame as Json;
    expect(frameKind(request)).toBe('request');
    expect(mapChatFrame(newChatMapper(FOLDER, false), request)).toEqual({ events: [], effects: [], drop: null, unread: true });
    expect(JSON.stringify(played.events)).not.toContain('fat-g-spike');
  });

  it('counts a request under its subtype when that is one of the list, and as `other` otherwise (C22)', () => {
    const request = load('m16-chat-request').find((entry) => entry.dir === 'recv' && entry.frame['type'] === 'control_request')?.frame as Json;
    expect(takeRequest(request)).toMatchObject({ requestId: '<request-11>', subtype: 'can_use_tool', tool: true, question: null });
    expect([...REQUEST_SUBTYPES]).toEqual(['can_use_tool', 'hook_callback', 'mcp_message', 'elicitation', 'request_user_dialog']);
    for (const subtype of REQUEST_SUBTYPES) expect(refusedSubtype(subtype)).toBe(subtype);
    for (const subtype of ['set_model', 'C:\\private\\path', 'can_use_tool; rm -rf', '', 7, null, undefined, { subtype: 'can_use_tool' }]) expect(refusedSubtype(subtype), JSON.stringify(subtype)).toBe('other');
    expect(takeRequest({ type: 'control_request', request_id: 'r', request: { subtype: 'hook_callback' } })).toEqual({ requestId: 'r', subtype: 'hook_callback', tool: false, question: null, action: null, plan: null, payload: null });
    expect(takeRequest({ type: 'control_request', request: 'nonsense' })).toEqual({ requestId: null, subtype: 'other', tool: false, question: null, action: null, plan: null, payload: null });
  });
});

describe('K17, a turn the CLI starts by itself (V13)', () => {
  const played = play('m16-self-turn');
  const worker = '<worker-11>';

  it('ends the first turn while its worker runs, and keeps the worker open: it belongs to the session, not to the turn', () => {
    valid(played);
    const first = play('m16-self-turn', { until: 17 });
    expect(first.ends()).toEqual([{ type: 'turn-ended', outcome: 'completed', answerItemId: '<uuid-23>', lost: false, detail: null }]);
    expect([...first.state.workers.keys()]).toEqual([worker]);
    expect(ofType(first, 'worker-ended')).toEqual([]);
  });

  it('gives the prompt written meanwhile its own turn, and maps the worker’s frames whenever they come', () => {
    expect(played.ends().map((end) => [end.outcome, end.answerItemId])).toEqual([['completed', '<uuid-23>'], ['completed', '<uuid-48>']]);
    const second = played.events.filter((event) => 'turnId' in event && event.turnId === RUNTIME(2)).map((event) => event.type);
    expect(second).toEqual(['turn-started', 'in-force', 'message']);
    expect(messages(played).map((message) => [message.turnId, message.text.slice(0, 20)])).toEqual([[RUNTIME(1), 'The sub-agent is now'], [RUNTIME(2), 'ok']]);
    // Ten reads by the worker, across both turns and after them, then its one end.
    expect(ofType(played, 'worker-progressed').filter((event) => event.kind === 'reading')).toHaveLength(10);
    expect(ofType(played, 'worker-progressed').filter((event) => event.kind === 'thinking')).toHaveLength(10);
    expect(ofType(played, 'worker-ended')).toEqual([{ type: 'worker-ended', workerId: worker, outcome: 'completed' }]);
    // The first turn's closing frame came after the second prompt was written: expected all the same.
    expect(played.state.closing).toBeNull();
  });

  it('drops and counts the frames of the turn the CLI started by itself, and shows none of its text (C31, C40)', () => {
    expect(played.drops).toEqual(['other-turn', 'other-turn', 'other-turn']);
    expect(JSON.stringify(played.events)).not.toContain('The background agent finished');
    expect(played.ends()).toHaveLength(2);
    expect(played.state.selfTurn).toBe(false);
    // One reference, at the first frame from a model, for the whole session.
    expect(ofType(played, 'session-started')).toEqual([{ type: 'session-started', reference: '<session-1>', folder: FOLDER }]);
  });
});

describe('the start check, at every `init` (V31; C21, C67, C83)', () => {
  const withInit = (patch: Json, name = 'm16-t3-subagent') => play(name, { change: (frame) => (isInit(frame) ? { ...frame, ...patch } : frame), until: 5 });

  it('passes T3 unchanged, whose `init` lists `Task` for the launch’s `Agent`, and each name the mode is reported as', () => {
    expect(at(load('m16-t3-subagent').find((entry) => isInit(entry.frame))?.frame, 'tools')).toEqual(expect.arrayContaining(['Task', 'Glob', 'Grep', 'Read']));
    expect(play('m16-t3-subagent').effects.filter((effect) => effect.type === 'overruled')).toEqual([]);
    // The names are the mode table's (M22, C5): the reading mode's, which a mapper is made for unless it is told another.
    expect(newChatMapper(FOLDER, false).mode).toBe(READING_MODE);
    expect([...READING_MODE.reported]).toEqual(['default', 'manual']);
    // M21 (C16): the fifth tool, which asks the user, as K1's `init` listed it beside the four.
    expect([...READING_MODE.reportedTools].sort()).toEqual(['Agent', 'AskUserQuestion', 'Glob', 'Grep', 'Read', 'Task']);
    expect((at(load('m21-question-one').find((entry) => isInit(entry.frame))?.frame, 'tools') as string[]).filter((tool) => !tool.startsWith('mcp__'))).toEqual(['Task', 'AskUserQuestion', 'Glob', 'Grep', 'Read']);
    expect(play('m21-question-one').effects.filter((effect) => effect.type === 'overruled')).toEqual([]);
    expect(withInit({ tools: ['Task', 'AskUserQuestion', 'Glob', 'Grep', 'Read'] }).effects.map((effect) => effect.type)).toEqual(['started']);
    for (const permissionMode of READING_MODE.reported) expect(withInit({ permissionMode }).effects.map((effect) => effect.type), permissionMode).toEqual(['started']);
    expect(withInit({ tools: ['Agent', 'Glob', 'Grep', 'Read'] }).effects.map((effect) => effect.type)).toEqual(['started']);
    // The tools a user's own configuration brings are not compared, however many there are.
    expect(withInit({ tools: ['Task', 'Read', 'mcp__anything__write_file', 'mcp__x__y'] }).effects.map((effect) => effect.type)).toEqual(['started']);
  });

  it('finds another permission mode, and a tool outside the launch’s list: no model is reported, and the session is told', () => {
    for (const patch of [
      { permissionMode: 'acceptEdits' }, { permissionMode: 'bypassPermissions' }, { permissionMode: 'plan' }, { permissionMode: undefined }, { permissionMode: 7 },
      { tools: ['Task', 'Glob', 'Grep', 'Read', 'Write'] }, { tools: ['Bash'] }, { tools: ['Task', 'Edit'] }, { tools: 'Read' }, { tools: undefined }, { tools: ['Read', 7] },
    ]) {
      const overruled = withInit(patch);
      expect(overruled.effects.map((effect) => effect.type), JSON.stringify(patch)).toEqual(['started', 'overruled']);
      expect(ofType(overruled, 'in-force')).toEqual([]);
      // The turn's own `init`: nothing is counted as dropped for it.
      expect(overruled.drops).toEqual([]);
    }
  });

  it('takes a name on neither list as a difference, whatever its cause: another spelling, another case', () => {
    for (const patch of [{ permissionMode: 'Default' }, { permissionMode: 'default ' }, { tools: ['task', 'Glob', 'Grep', 'Read'] }, { tools: ['Task', 'Glob', 'Grep', 'Read', 'MCP__x'] }, { tools: ['Task', 'Glob', 'Grep', 'Read', 'mcp_single'] }]) {
      expect(withInit(patch).effects.map((effect) => effect.type), JSON.stringify(patch)).toEqual(['started', 'overruled']);
    }
  });

  it('is made on the `init` of a turn the CLI started by itself too, with no turn of a prompt’s to fail (C83)', () => {
    const own = play('m16-self-turn', { change: (frame, index) => (index === 59 ? { ...frame, tools: [...(frame['tools'] as string[]), 'Write'] } : frame) });
    expect(own.effects.map((effect) => effect.type)).toEqual(['started', 'turn-ended', 'started', 'turn-ended', 'overruled']);
    expect(own.drops).toEqual(['other-turn', 'other-turn', 'other-turn']);
    // And unchanged, that `init` passes: it is checked, and dropped as no frame of a prompt's turn.
    expect(play('m16-self-turn').effects.filter((effect) => effect.type === 'overruled')).toEqual([]);
  });
});

describe('a `result` that never came (V13; C41, C76)', () => {
  const without = (name: string) => play(name, { change: (frame) => (isResult(frame) ? null : frame) });

  it('is made up for by the closing frame, and the turn ends as that frame reads', () => {
    const completed = without('m16-t1-basic');
    expect(completed.ends()).toEqual([{ type: 'turn-ended', outcome: 'completed', answerItemId: '<uuid-13>', lost: true, detail: null }]);
    expect(endFailure(completed.ends()[0] as End)).toBeUndefined();

    const stopped = without('m16-t4-interrupt');
    expect(stopped.ends()).toEqual([{ type: 'turn-ended', outcome: 'interrupted', answerItemId: null, lost: true, detail: null }]);

    const failed = without('m16-t5-error');
    expect(failed.ends()).toEqual([{ type: 'turn-ended', outcome: 'failed', answerItemId: null, lost: true, detail: null }]);
    expect(endFailure(failed.ends()[0] as End)).toBe('end-lost');
    for (const played of [completed, stopped, failed]) expect(played.drops).toEqual([]);
  });

  it('ends a turn once: the closing frame after a `result` ends nothing, and neither does a second of either', () => {
    const state = newChatMapper(FOLDER, false);
    const played = blank(state);
    const frames = load('m16-t1-basic').filter((entry) => entry.dir === 'recv' && entry.frame['type'] !== 'control_response').map((entry) => entry.frame);
    beginChatTurn(state, RUNTIME(1), '<uuid-2>');
    for (const frame of frames) feed(played, frame);
    feed(played, frames.find(isResult));
    feed(played, frames.at(-1));
    expect(played.ends()).toHaveLength(1);
    // A second `result` is a frame of no turn in flight.
    expect(played.drops).toEqual(['other-turn']);
  });
});

describe('a frame of no turn (V13, V30; C31, C40, C76)', () => {
  it('is dropped and counted: before any prompt, after a turn’s end, and of another prompt’s id', () => {
    const state = newChatMapper(FOLDER, false);
    const played = blank(state);
    const t1 = load('m16-t1-basic').filter((entry) => entry.dir === 'recv' && entry.frame['type'] !== 'control_response').map((entry) => entry.frame);
    for (const frame of t1) feed(played, frame);
    expect(played.events).toEqual([]);
    // Lifecycle frames of a prompt fat-g did not write, the `init` no `started` of fat-g's precedes, the two own `assistant` frames,
    // the read's result (M20a, C18) and the `result`.
    expect(played.drops).toEqual(['other-turn', 'other-turn', 'other-turn', 'other-turn', 'other-turn', 'other-turn', 'other-turn', 'other-turn']);
    expect(played.unread).toBe(1);
    expect(played.ends()).toEqual([]);
  });

  it('gives a missing session’s `result`, which comes before any reply, to no turn (C26, C76)', () => {
    const missing = load('m16-resume-failures-missing').find((entry) => entry.dir === 'recv')?.frame;
    const state = newChatMapper(FOLDER, true);
    beginChatTurn(state, RUNTIME(1), 'prompt-1');
    const played = blank(state);
    feed(played, missing);
    // The prompt was not written yet, and the CLI took none: the frame ends nothing.
    expect(played.ends()).toEqual([]);
    expect(played.drops).toEqual(['other-turn']);
    expect(JSON.stringify(played.events)).not.toContain('No conversation found');
  });

  it('drops a hook’s frames before the reply, and the rate limit between `started` and the `init` (K26)', () => {
    const played = play('m16-chat-hooks');
    valid(played);
    expect(played.order).toEqual(['turn-started', 'in-force', 'session-started', 'message', 'end:completed']);
    // Two hook frames and one rate limit: unread, with nothing of them parsed into an event.
    expect(played.unread).toBe(3);
    expect(JSON.stringify(played.events)).not.toMatch(/hook|SessionStart/);
  });
});

describe('the reference, at the session’s first frame from a model (V38; C87)', () => {
  it('follows a text, a tool call or a thinking frame, and never the `init`', () => {
    for (const [name, index, block] of [['m16-t3-subagent', 7, 'text'], ['m16-t1-basic', 7, 'tool_use'], ['m16-forced-turn-cut', 7, 'thinking']] as const) {
      expect(at(load(name).find((entry) => entry.index === index)?.frame, 'message', 'content', 0, 'type')).toBe(block);
      const before = play(name, { until: index - 1 });
      expect(ofType(before, 'session-started'), name).toEqual([]);
      expect(before.state.sessionId).toBe('<session-1>');
      const after = play(name, { until: index });
      expect(ofType(after, 'session-started'), name).toEqual([{ type: 'session-started', reference: '<session-1>', folder: FOLDER }]);
      // Before that frame's own events.
      expect(after.order.indexOf('session-started')).toBe(after.order.indexOf('in-force') + 1);
    }
    // K27's turn was cut at its first tool call: the reference had come, and no end of the CLI's did.
    const cut = play('m16-forced-turn-cut');
    expect(cut.ends()).toEqual([]);
    expect(cut.order).toEqual(['turn-started', 'in-force', 'session-started']);
    expect(actions(cut).map((event) => event.kind)).toEqual(['reading', 'thinking']);
  });

  it('is reported once, and not at all for a session resumed by one', () => {
    expect(ofType(play('m16-t3-subagent'), 'session-started')).toHaveLength(1);
    expect(ofType(play('m16-t3-subagent', { referenced: true }), 'session-started')).toEqual([]);
    expect(ofType(play('m16-self-turn'), 'session-started')).toHaveLength(1);
  });

  it('comes at the same process’s next turn after a first turn with no frame from a model', () => {
    for (const first of ['m16-chat-early-interrupt', 'm16-t5-error', 'm16-command-refused']) {
      const one = play(first);
      expect(ofType(one, 'session-started'), first).toEqual([]);
      const two = play('m16-t1-basic', { state: one.state, firstTurn: 2 });
      expect(ofType(two, 'session-started'), first).toEqual([{ type: 'session-started', reference: '<session-1>', folder: FOLDER }]);
      expect(two.ends()[0]).toMatchObject({ outcome: 'completed' });
      expect(two.events.filter((event) => 'turnId' in event).every((event) => 'turnId' in event && event.turnId === RUNTIME(2))).toBe(true);
    }
  });

  it('is not made of a worker’s frame, nor of an `init` that names no id', () => {
    const state = newChatMapper(FOLDER, false);
    beginChatTurn(state, RUNTIME(1), 'p');
    const played = blank(state);
    feed(played, { type: 'command_lifecycle', command_uuid: 'p', state: 'started' });
    feed(played, { type: 'system', subtype: 'init', tools: ['Read'], permissionMode: 'default', model: 'claude-sonnet-5', session_id: 'a\nb' });
    feed(played, { type: 'assistant', uuid: 'w1', parent_tool_use_id: 'tool-1', message: { model: 'claude-sonnet-5', content: [{ type: 'text', text: 'a worker speaks' }] } });
    feed(played, { type: 'assistant', uuid: 'u1', parent_tool_use_id: null, message: { model: 'claude-sonnet-5', content: [{ type: 'text', text: 'hello' }] } });
    expect(played.order).toEqual(['turn-started', 'in-force', 'message']);
    expect(played.state.referenced).toBe(false);
  });
});

describe('workers (V13; C39)', () => {
  const tasks = load('m16-worker-interrupt').filter((entry) => entry.dir === 'recv' && entry.frame['type'] === 'system' && String(entry.frame['subtype']).startsWith('task_')).map((entry) => entry.frame);

  it('ends the worker of an interrupted turn once, as failed, by K11’s two frames', () => {
    const played = blank(newChatMapper(FOLDER, false));
    for (const frame of tasks) feed(played, frame);
    expect(tasks.map((frame) => frame['subtype'])).toEqual(['task_started', 'task_progress', 'task_updated', 'task_notification']);
    expect([at(tasks[2], 'patch', 'status'), tasks[3]?.['status']]).toEqual(['killed', 'stopped']);
    expect(played.order).toEqual(['worker-started', 'worker-ended']);
    expect(ofType(played, 'worker-ended')).toEqual([{ type: 'worker-ended', workerId: '<worker-8>', outcome: 'failed' }]);
    valid(played);
  });

  it('ends at the notification alone when no update closed it, and takes an update that closes nothing as no end', () => {
    const played = blank(newChatMapper(FOLDER, false));
    feed(played, tasks[0]);
    feed(played, { type: 'system', subtype: 'task_updated', task_id: '<worker-8>', patch: { is_backgrounded: true } });
    feed(played, { type: 'system', subtype: 'task_updated', task_id: '<worker-8>', patch: { status: 'running' } });
    expect(ofType(played, 'worker-ended')).toEqual([]);
    feed(played, { type: 'system', subtype: 'task_notification', task_id: '<worker-8>', status: 'completed' });
    expect(ofType(played, 'worker-ended')).toEqual([{ type: 'worker-ended', workerId: '<worker-8>', outcome: 'completed' }]);
    // A status the adapter does not know is no success.
    const odd = blank(newChatMapper(FOLDER, false));
    feed(odd, tasks[0]);
    feed(odd, { type: 'system', subtype: 'task_notification', task_id: '<worker-8>', status: 'something-new' });
    expect(ofType(odd, 'worker-ended')).toEqual([{ type: 'worker-ended', workerId: '<worker-8>', outcome: 'failed' }]);
  });

  it('ends every open worker as failed when the session says so, and their later frames then change nothing', () => {
    const played = blank(newChatMapper(FOLDER, false));
    feed(played, tasks[0]);
    feed(played, { ...tasks[0], task_id: 'worker-b' });
    expect(failChatWorkers(played.state)).toEqual([{ type: 'worker-ended', workerId: '<worker-8>', outcome: 'failed' }, { type: 'worker-ended', workerId: 'worker-b', outcome: 'failed' }]);
    const before = played.events.length;
    for (const frame of tasks.slice(1)) feed(played, frame);
    expect(played.events).toHaveLength(before);
    expect(played.drops).toEqual([]);
    expect(failChatWorkers(played.state)).toEqual([]);
  });

  it('gives a worker’s action by the tool it names, by the same table as the session’s', () => {
    const kinds = (tool: unknown) => {
      const played = blank(newChatMapper(FOLDER, false));
      feed(played, tasks[0]);
      feed(played, { type: 'system', subtype: 'task_progress', task_id: '<worker-8>', last_tool_name: tool, description: 'Reading C:\\private\\notes.txt' });
      return ofType(played, 'worker-progressed');
    };
    expect(kinds('Read')).toEqual([]);
    expect(kinds('Task')).toEqual([]);
    expect(kinds('Agent')).toEqual([]);
    expect(kinds('Grep')).toEqual([]);
    expect(kinds('mcp__server__tool')).toEqual([]);
    // No tool named: no action; and never a line, a path or a description.
    expect(kinds(undefined)).toEqual([]);
    expect(JSON.stringify(kinds('Read'))).not.toContain('private');
  });
});

describe('bounds and frames that are not what they should be', () => {
  const started = (): Played => {
    const state = newChatMapper(FOLDER, true);
    beginChatTurn(state, RUNTIME(1), 'p');
    const played = blank(state);
    feed(played, { type: 'command_lifecycle', command_uuid: 'p', state: 'started' });
    feed(played, { type: 'system', subtype: 'init', tools: ['Read'], permissionMode: 'default', model: 'claude-sonnet-5', session_id: 's' });
    return played;
  };
  const text = (value: string, uuid: unknown = 'u1'): Json => ({ type: 'assistant', uuid, parent_tool_use_id: null, message: { model: 'claude-sonnet-5', content: [{ type: 'text', text: value }] } });

  it('cuts a text past its bound and says so, and a label to its own', () => {
    const played = started();
    feed(played, text(`${'x'.repeat(MAX_LINE_INPUT + 50)}\nsecond line ${'y'.repeat(MAX_MESSAGE_TEXT)}`));
    const [message] = messages(played);
    expect(message?.text).toHaveLength(MAX_MESSAGE_TEXT);
    expect(message?.cut).toBe(true);
    expect(played.state.turn?.commentary).toHaveLength(MAX_LINE_INPUT);
    valid(played);
    // A text at the bound is not cut.
    const exact = started();
    feed(exact, text('z'.repeat(MAX_MESSAGE_TEXT)));
    expect(messages(exact)[0]).not.toHaveProperty('cut');
  });

  it('takes the first line that holds anything as the label, and keeps the last label through a text with none', () => {
    const played = started();
    feed(played, text('\n\n  \nLooking at the tide table.\nMore.'));
    feed(played, text('   \n  ', 'u2'));
    feed(played, { type: 'assistant', uuid: 'u3', parent_tool_use_id: null, message: { model: 'claude-sonnet-5', content: [{ type: 'tool_use', id: 'glob-label', name: 'Glob', input: { pattern: '**/*.private' } }] } });
    expect(actions(played).map((event) => [event.kind, event.line])).toEqual([['tool', 'Looking at the tide table.']]);
    expect(JSON.stringify(actions(played))).not.toContain('private');
  });

  it('drops a frame it cannot take as invalid: a text with no id, a lifecycle frame with none, a worker with none', () => {
    const played = started();
    for (const frame of [
      text('no id', null), text('an id with a line break', 'a\nb'), text('an id too long', 'x'.repeat(300)),
      { type: 'assistant', uuid: 'u9', parent_tool_use_id: null, message: { model: 'm', content: 'not a list' } },
      { type: 'assistant', uuid: 'u9', parent_tool_use_id: null },
      { type: 'command_lifecycle', state: 'started' },
      { type: 'system', subtype: 'task_started', description: 'no id' },
      { type: 'system', subtype: 'task_started', task_id: '' },
    ]) feed(played, frame);
    expect(played.drops).toEqual(['invalid', 'invalid', 'invalid', 'invalid', 'invalid', 'invalid', 'invalid', 'invalid']);
    expect(messages(played)).toEqual([]);
    expect(ofType(played, 'worker-started')).toEqual([]);
    valid(played);
  });

  it('reads an `init` that names no usable model as it is: the check is made, and no model is reported', () => {
    const state = newChatMapper(FOLDER, true);
    beginChatTurn(state, RUNTIME(1), 'p');
    const played = blank(state);
    feed(played, { type: 'command_lifecycle', command_uuid: 'p', state: 'started' });
    feed(played, { type: 'system', subtype: 'init', tools: ['Read'], permissionMode: 'default', model: 'x'.repeat(200), session_id: 's' });
    expect(played.order).toEqual(['turn-started']);
    expect(played.effects.map((effect) => effect.type)).toEqual(['started']);
    expect(played.state.turn?.inited).toBe(true);
  });

  it('takes a second `init` inside a prompt’s turn as that turn’s, not as a turn of the CLI’s own', () => {
    const played = started();
    feed(played, { type: 'system', subtype: 'init', tools: ['Read'], permissionMode: 'default', model: 'claude-sonnet-5', session_id: 's' });
    feed(played, text('still this turn'));
    expect(played.drops).toEqual([]);
    expect(messages(played)).toHaveLength(1);
    expect(played.state.selfTurn).toBe(false);
  });

  it('keeps a turn’s last text as commentary when the turn fails or is interrupted: the end names none (C35)', () => {
    for (const stopped of [false, true]) {
      const played = started();
      feed(played, text('Almost done.'));
      if (stopped && played.state.turn !== null) played.state.turn.stopped = true;
      feed(played, { type: 'result', is_error: true, subtype: 'success' });
      expect(messages(played)[0]).toMatchObject({ phase: 'commentary' });
      expect(played.ends()).toEqual([{ type: 'turn-ended', outcome: stopped ? 'interrupted' : 'failed', answerItemId: null, lost: false, detail: null }]);
    }
    // A `result` that does not say it is no error is an error.
    const unsaid = started();
    feed(unsaid, { type: 'result' });
    expect(unsaid.ends()[0]).toMatchObject({ outcome: 'failed' });
  });
});

// ── M19: a reply as it is written ─────────────────────────────────────────────────────────────
// V4 (docs/planning/_archive/M19.md, Design 3; C9–C13, C60), per K2 capture: the launch that asks for partial
// messages gets a reply's `stream_event` frames beside its `assistant` frames, and a text is one
// message from its block's start.
describe('a text as it is written (M19: V4)', () => {
  const deltas = (played: Played) => ofType(played, 'message-delta');
  const isStream = (frame: Json): boolean => frame['type'] === 'stream_event';
  const eventOf = (frame: Json): string => String(at(frame, 'event', 'type'));
  /** The capture's own frames: its own text frames, in order, each with its reply's id and its text. */
  const textFrames = (name: string) => load(name).filter((entry) => entry.dir === 'recv' && entry.frame['type'] === 'assistant' && entry.frame['parent_tool_use_id'] === null && at(entry.frame, 'message', 'content', 0, 'type') === 'text')
    .map((entry) => ({ uuid: String(entry.frame['uuid']), replyId: String(at(entry.frame, 'message', 'id')), text: String(at(entry.frame, 'message', 'content', 0, 'text')) }));
  /** What a streamed turn must hold: every delta opens or follows its message's opening, in its turn, before its whole message. */
  function sound(played: Played): ReturnType<typeof foldDeltas> {
    valid(played);
    const folded = foldDeltas(played.events);
    expect(folded.faults).toEqual([]);
    return folded;
  }
  const stream = (event: Json, extra: Json = {}): Json => ({ type: 'stream_event', parent_tool_use_id: null, event, ...extra });
  const replyStart = (id: string, model = 'claude-sonnet-5'): Json => stream({ type: 'message_start', message: { id, model } });
  const blockStart = (index: number, type = 'text'): Json => stream({ type: 'content_block_start', index, content_block: { type } });
  const textDelta = (index: number, value: string): Json => stream({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: value } });
  const started = (): Played => {
    const state = newChatMapper(FOLDER, true);
    beginChatTurn(state, RUNTIME(1), 'p');
    const played = blank(state);
    feed(played, { type: 'command_lifecycle', command_uuid: 'p', state: 'started' });
    feed(played, { type: 'system', subtype: 'init', tools: ['Read'], permissionMode: 'default', model: 'claude-sonnet-5', session_id: 's' });
    return played;
  };
  const frameOf = (replyId: string, uuid: string, block: Json): Json => ({ type: 'assistant', uuid, parent_tool_use_id: null, message: { id: replyId, model: 'claude-sonnet-5', content: [block] } });

  it('T1: opens the answer at its block’s start under its reply’s id and the block’s index, grows it, and completes it by its frame', () => {
    const played = play('m19-t1-basic');
    const folded = sound(played);
    expect(played.drops).toEqual([]);
    const [frame] = textFrames('m19-t1-basic');
    const itemId = `${frame?.replyId}#0`;
    expect(messages(played)).toEqual([{ type: 'message', turnId: RUNTIME(1), role: 'assistant', itemId, phase: 'commentary', text: frame?.text }]);
    const mine = deltas(played);
    // Only the text streams: the tool call's input, written in deltas too, is nothing of the chat's.
    expect(new Set(mine.map((delta) => delta.itemId))).toEqual(new Set([itemId]));
    // No phase is said while it is written (C79): the frame that completes it says commentary, and the end names the answer.
    expect(mine[0]).toEqual({ type: 'message-delta', turnId: RUNTIME(1), itemId, phase: null, text: '' });
    expect(mine.every((delta) => delta.phase === null)).toBe(true);
    expect(mine.length).toBeGreaterThan(2);
    expect(folded.streamed.get(itemId)).toBe(frame?.text);
    expect(folded.open).toEqual([]);
    // In the order the frames came: the reference at the first reply's start, the read, then the text as it is written.
    expect(played.order.filter((type, index, all) => type !== 'message-delta' || all[index - 1] !== 'message-delta'))
      .toEqual(['turn-started', 'in-force', 'session-started', 'message-delta', 'message', 'end:completed']);
    expect(actions(played).map((event) => event.kind)).toEqual(['reading', 'thinking', 'writing', 'thinking']);
    // The answer the completed end names is the streamed message (C74): the store settles that item as final.
    expect(played.ends()).toEqual([{ type: 'turn-ended', outcome: 'completed', answerItemId: itemId, lost: false, detail: null }]);
    // The reply is forgotten at its end.
    expect(played.state.reply).toBeNull();
  });

  it('T3: each text is its own message under its own reply; the tool call beside it and the worker’s frames open nothing', () => {
    const played = play('m19-t3-subagent');
    const folded = sound(played);
    expect(played.drops).toEqual([]);
    const frames = textFrames('m19-t3-subagent');
    expect(frames).toHaveLength(2);
    // The first reply holds a text and then a tool call: its second frame is the tool call's, and is no message.
    expect(messages(played).map((message) => [message.itemId, message.text])).toEqual(frames.map((frame) => [`${frame.replyId}#0`, frame.text]));
    expect([...folded.streamed.keys()]).toEqual(frames.map((frame) => `${frame.replyId}#0`));
    for (const frame of frames) expect(folded.streamed.get(`${frame.replyId}#0`)).toBe(frame.text);
    // The commentary is whole before the worker starts, as M16 has it.
    expect(played.order.indexOf('message')).toBeLessThan(played.order.indexOf('worker-started'));
    expect(played.ends()[0]).toMatchObject({ outcome: 'completed', answerItemId: `${frames[1]?.replyId}#0` });
    // No text of the worker's, and no delta of it: K2's worker sent no stream event (C12).
    expect(load('m19-t3-subagent').filter((entry) => isStream(entry.frame) && entry.frame['parent_tool_use_id'] !== null)).toEqual([]);
  });

  it('the Markdown answer: 267 deltas put together are the whole message’s text, one message', () => {
    const played = play('m19-markdown');
    const folded = sound(played);
    const [frame] = textFrames('m19-markdown');
    const itemId = `${frame?.replyId}#0`;
    expect(deltas(played)).toHaveLength(268);
    expect(folded.streamed.get(itemId)).toBe(frame?.text);
    expect(messages(played)).toHaveLength(1);
    expect(messages(played)[0]).toMatchObject({ itemId, text: frame?.text });
    expect(played.drops).toEqual([]);
  });

  it('T4: thinking, its signature and a tool’s input are passed over, counted neither as drops nor as unread; the text its Stop cut is left as it was received', () => {
    const played = play('m19-t4-interrupt');
    const folded = sound(played);
    expect(played.drops).toEqual([]);
    const passed = load('m19-t4-interrupt').filter((entry) => isStream(entry.frame) && ['thinking_delta', 'signature_delta', 'input_json_delta'].includes(String(at(entry.frame, 'event', 'delta', 'type'))));
    expect(passed.length).toBeGreaterThan(20);
    // What is not read of a reply is not what `unread` counts: that is the frames of kinds never parsed,
    // and a `user` frame with no tool result in it, the interrupt's mark here (M20a, C18).
    const noResult = (frame: Json): boolean => frameKind(frame) === 'tool-results' && !(Array.isArray(at(frame, 'message', 'content')) && (at(frame, 'message', 'content') as Json[]).some((block) => block['type'] === 'tool_result'));
    expect(played.unread).toBe(load('m19-t4-interrupt').filter((entry) => entry.dir === 'recv' && entry.frame['type'] !== 'control_response' && (frameKind(entry.frame) === 'unread' || frameKind(entry.frame) === 'status' || noResult(entry.frame))).length);
    const [frame] = textFrames('m19-t4-interrupt');
    const itemId = `${frame?.replyId}#0`;
    // One text was being written when the Stop came: 15 ms later the CLI sent the frame with what it had.
    expect(frame?.text).toBe('Summ');
    expect(deltas(played).map((delta) => [delta.itemId, delta.text])).toEqual([[itemId, ''], [itemId, 'Summ']]);
    // The frame that holds it does not complete it (C80): no whole message, and the turn's end leaves it
    // open, for the chat to keep as unfinished. Neither a note nor the answer, it says no phase (C79).
    expect(messages(played)).toEqual([]);
    expect(folded.open).toEqual([itemId]);
    expect(folded.streamed.get(itemId)).toBe('Summ');
    expect(deltas(played).every((delta) => delta.phase === null)).toBe(true);
    expect(played.state.turn?.held).toEqual([]);
    // M16's end stands: interrupted, by the CLI's own `result`, with no answer named (C13).
    expect(played.ends()).toEqual([{ type: 'turn-ended', outcome: 'interrupted', answerItemId: null, lost: false, detail: null }]);
    expect(actions(played).map((event) => event.kind)).toEqual(['reading', 'thinking', 'reading', 'thinking', 'reading', 'thinking', 'reading', 'thinking', 'writing', 'thinking']);
  });

  it('T5 and a refused command: the CLI’s own replies send no stream event, so their text is whole, under its frame’s id, and no reference is made', () => {
    for (const name of ['m19-t5-error', 'm19-command-refused']) {
      expect(load(name).filter((entry) => isStream(entry.frame)), name).toEqual([]);
      const played = play(name);
      expect(deltas(played), name).toEqual([]);
      expect(ofType(played, 'session-started'), name).toEqual([]);
    }
    const refused = play('m19-command-refused');
    expect(messages(refused).map((message) => message.itemId)).toEqual(textFrames('m19-command-refused').map((frame) => frame.uuid));
    expect(play('m19-t5-error').ends()[0]).toMatchObject({ outcome: 'failed' });
  });

  it('a reply cut during its first text block: the reference came at the reply’s start, before any of its text, and the message is left open (C60)', () => {
    const played = play('m19-cut-cut');
    const folded = sound(played);
    // The process was ended by force: no frame completes the text, and no end of the CLI's comes.
    expect(messages(played)).toEqual([]);
    expect(played.ends()).toEqual([]);
    expect(folded.open).toHaveLength(1);
    expect((folded.streamed.get(folded.open[0] ?? '') ?? '').length).toBeGreaterThan(100);
    expect(ofType(played, 'session-started')).toEqual([{ type: 'session-started', reference: '<session-1>', folder: FOLDER }]);
    expect(played.order.indexOf('session-started')).toBeLessThan(played.order.indexOf('message-delta'));
    expect(played.order.slice(0, 3)).toEqual(['turn-started', 'in-force', 'session-started']);
    // The session resumed by that reference answers, and reports none again.
    const resumed = play('m19-cut-resumed', { referenced: true });
    sound(resumed);
    expect(ofType(resumed, 'session-started')).toEqual([]);
    expect(resumed.ends()[0]).toMatchObject({ outcome: 'completed' });
  });

  it('reports the reference once, at the first reply from a model, and falls back to the first frame from one where no reply’s start came (C60)', () => {
    for (const name of ['m19-t1-basic', 'm19-t3-subagent', 'm19-t4-interrupt', 'm19-markdown']) {
      const played = play(name);
      expect(ofType(played, 'session-started'), name).toEqual([{ type: 'session-started', reference: '<session-1>', folder: FOLDER }]);
      // At the reply's start: after the `init`, and before anything the reply holds.
      expect(played.order.indexOf('session-started'), name).toBe(played.order.indexOf('in-force') + 1);
      expect(ofType(play(name, { referenced: true }), 'session-started'), name).toEqual([]);
    }
    // No stream event at all — a CLI that sent none, or every one of them lost: M16's rule holds.
    const whole = play('m19-t1-basic', { change: (frame) => (isStream(frame) ? null : frame) });
    expect(ofType(whole, 'session-started')).toHaveLength(1);
    expect(whole.order.slice(0, 3)).toEqual(['turn-started', 'in-force', 'session-started']);
    // A worker's reply, and a reply of the CLI's own, establish none.
    const none = started();
    none.state.referenced = false;
    none.state.sessionId = 's-1';
    feed(none, stream({ type: 'message_start', message: { id: 'msg_w', model: 'claude-sonnet-5' } }, { parent_tool_use_id: 'tool-1' }));
    feed(none, replyStart('msg_s', '<synthetic>'));
    feed(none, stream({ type: 'message_start', message: { id: 'msg_n' } }));
    expect(ofType(none, 'session-started')).toEqual([]);
    feed(none, replyStart('msg_m'));
    expect(ofType(none, 'session-started')).toEqual([{ type: 'session-started', reference: 's-1', folder: FOLDER }]);
  });

  it('takes a text frame no block opened as a whole message under its own id: every stream event lost, or the block’s start alone (C11)', () => {
    const [frame] = textFrames('m19-t1-basic');
    const lost = play('m19-t1-basic', { change: (entry) => (isStream(entry) ? null : entry) });
    expect(deltas(lost)).toEqual([]);
    expect(messages(lost)).toEqual([{ type: 'message', turnId: RUNTIME(1), role: 'assistant', itemId: frame?.uuid, phase: 'commentary', text: frame?.text }]);
    expect(lost.ends()[0]).toMatchObject({ outcome: 'completed', answerItemId: frame?.uuid });
    expect(lost.drops).toEqual([]);
    // The text block's start lost: its deltas name a block that never opened, and are dropped and counted.
    const unopened = play('m19-t1-basic', { change: (entry) => (isStream(entry) && eventOf(entry) === 'content_block_start' && at(entry, 'event', 'content_block', 'type') === 'text' ? null : entry) });
    expect(deltas(unopened)).toEqual([]);
    expect(new Set(unopened.drops)).toEqual(new Set(['unopened-item']));
    expect(messages(unopened).map((message) => message.itemId)).toEqual([frame?.uuid]);
    // The reply's start lost: nothing of it opens, and its frames are whole.
    const headless = play('m19-markdown', { change: (entry) => (isStream(entry) && eventOf(entry) === 'message_start' ? null : entry) });
    expect(deltas(headless)).toEqual([]);
    expect(headless.drops).toHaveLength(267);
    expect(messages(headless).map((message) => message.itemId)).toEqual(textFrames('m19-markdown').map((entry) => entry.uuid));
  });

  it('makes two texts of one reply two messages, each by its own block’s index, a tool call between them counted as a frame of the reply', () => {
    const played = started();
    for (const frame of [
      replyStart('msg_1'),
      blockStart(0), textDelta(0, 'First, '), textDelta(0, 'the plan.'), frameOf('msg_1', 'u-1', { type: 'text', text: 'First, the plan.' }),
      blockStart(1, 'tool_use'), stream({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"file_path":"secret.txt"}' } }), frameOf('msg_1', 'u-2', { type: 'tool_use', name: 'Read', input: { file_path: 'D:\\x\\notes.txt' } }),
      blockStart(2), textDelta(2, 'Then the answer.'), frameOf('msg_1', 'u-3', { type: 'text', text: 'Then the answer.' }),
      stream({ type: 'content_block_stop', index: 2 }), stream({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }), stream({ type: 'message_stop' }),
    ]) feed(played, frame);
    sound(played);
    expect(played.drops).toEqual([]);
    expect(messages(played).map((message) => [message.itemId, message.text])).toEqual([['msg_1#0', 'First, the plan.'], ['msg_1#2', 'Then the answer.']]);
    expect(deltas(played).map((delta) => `${delta.itemId}:${delta.text}`)).toEqual(['msg_1#0:', 'msg_1#0:First, ', 'msg_1#0:the plan.', 'msg_1#2:', 'msg_1#2:Then the answer.']);
    // Nothing of the tool's input, written in deltas too, is in any event.
    expect(JSON.stringify(played.events)).not.toContain('secret');
    expect(played.state.reply).toBeNull();
  });

  it('holds the whole message as the authority: a frame whose text is another than its deltas brought replaces it, and a delta after it changes nothing', () => {
    const played = started();
    for (const frame of [replyStart('msg_1'), blockStart(0), textDelta(0, 'A draft'), frameOf('msg_1', 'u-1', { type: 'text', text: 'The final wording.' }), textDelta(0, ' too late')]) feed(played, frame);
    expect(messages(played)).toEqual([expect.objectContaining({ itemId: 'msg_1#0', text: 'The final wording.' })]);
    expect(played.drops).toEqual(['completed-item']);
    expect(deltas(played).map((delta) => delta.text)).toEqual(['', 'A draft']);
    // A second frame for a block already completed is a message of its own, under its own id.
    const again = started();
    for (const frame of [replyStart('msg_1'), blockStart(0), textDelta(0, 'One.'), frameOf('msg_1', 'u-1', { type: 'text', text: 'One.' }), frameOf('msg_1', 'u-2', { type: 'text', text: 'Unannounced.' })]) feed(again, frame);
    expect(messages(again).map((message) => message.itemId)).toEqual(['msg_1#0', 'u-2']);
  });

  it('says no phase for a text while it is written, whatever it turns out to be: commentary before a tool call, or the answer (C79)', () => {
    for (const name of ['m19-t1-basic', 'm19-t3-subagent', 'm19-t4-interrupt', 'm19-markdown', 'm19-cut-cut']) {
      const played = play(name);
      expect(deltas(played).length, name).toBeGreaterThan(0);
      expect(deltas(played).every((delta) => delta.phase === null), name).toBe(true);
      // Whole, each text has the phase every text of Claude's has (M16, C74). The one T4's Stop cut is never whole (C80).
      expect(messages(played).every((message) => message.phase === 'commentary'), name).toBe(true);
    }
  });

  it('leaves a text whose frame comes after the turn’s Stop as it was received, and does not complete it (C80)', () => {
    // The usual case: the frame holds what the deltas brought, and adds nothing.
    const streamed = started();
    for (const frame of [replyStart('msg_1'), blockStart(0), textDelta(0, 'The answer beg')]) feed(streamed, frame);
    if (streamed.state.turn !== null) streamed.state.turn.stopped = true;
    const before = streamed.events.length;
    feed(streamed, frameOf('msg_1', 'u-1', { type: 'text', text: 'The answer beg' }));
    expect(streamed.events.slice(before).map((event) => event.type)).toEqual(['action-changed']);
    feed(streamed, { type: 'result', is_error: true, subtype: 'error_during_execution' });
    expect(messages(streamed)).toEqual([]);
    expect(streamed.ends()).toEqual([{ type: 'turn-ended', outcome: 'interrupted', answerItemId: null, lost: false, detail: null }]);
    expect(sound(streamed).open).toEqual(['msg_1#0']);

    // The frame holds more than the deltas brought: the rest is appended, and the message stays open.
    const more = started();
    for (const frame of [replyStart('msg_1'), blockStart(0), textDelta(0, 'The answer')]) feed(more, frame);
    if (more.state.turn !== null) more.state.turn.stopped = true;
    feed(more, frameOf('msg_1', 'u-1', { type: 'text', text: 'The answer began here' }));
    feed(more, { type: 'result', is_error: true });
    expect(messages(more)).toEqual([]);
    const folded = sound(more);
    expect(folded.open).toEqual(['msg_1#0']);
    expect(folded.streamed.get('msg_1#0')).toBe('The answer began here');

    // A text no block opened: opened under its frame's own id, with all of its text, and left open.
    const whole = started();
    if (whole.state.turn !== null) whole.state.turn.stopped = true;
    feed(whole, frameOf('msg_2', 'u-2', { type: 'text', text: 'Cut short' }));
    feed(whole, { type: 'result', is_error: true });
    expect(messages(whole)).toEqual([]);
    expect(deltas(whole)).toEqual([{ type: 'message-delta', turnId: RUNTIME(1), itemId: 'u-2', phase: null, text: '' }, { type: 'message-delta', turnId: RUNTIME(1), itemId: 'u-2', phase: null, text: 'Cut short' }]);
    expect(sound(whole).open).toEqual(['u-2']);

    // A text that was whole before the Stop is what it was: a note, complete.
    const earlier = started();
    for (const frame of [replyStart('msg_3'), blockStart(0), textDelta(0, 'I will read it.'), frameOf('msg_3', 'u-3', { type: 'text', text: 'I will read it.' })]) feed(earlier, frame);
    if (earlier.state.turn !== null) earlier.state.turn.stopped = true;
    feed(earlier, { type: 'result', is_error: true });
    expect(messages(earlier).map((message) => [message.phase, message.text])).toEqual([['commentary', 'I will read it.']]);
    expect(sound(earlier).open).toEqual([]);
  });

  it('completes it after all where the turn completes: the Stop came too late, and the end names it the answer (C80)', () => {
    const played = started();
    for (const frame of [replyStart('msg_1'), blockStart(0), textDelta(0, 'All of the answer.')]) feed(played, frame);
    if (played.state.turn !== null) played.state.turn.stopped = true;
    feed(played, frameOf('msg_1', 'u-1', { type: 'text', text: 'All of the answer.' }));
    expect(messages(played)).toEqual([]);
    // The turn's own end says it completed: the frame's message goes out before that end.
    feed(played, { type: 'result', is_error: false });
    expect(messages(played)).toEqual([{ type: 'message', turnId: RUNTIME(1), role: 'assistant', itemId: 'msg_1#0', phase: 'commentary', text: 'All of the answer.' }]);
    expect(played.ends()).toEqual([{ type: 'turn-ended', outcome: 'completed', answerItemId: 'msg_1#0', lost: false, detail: null }]);
    expect(played.order.slice(-2)).toEqual(['message', 'end:completed']);
    expect(sound(played).open).toEqual([]);
    // The same where the closing frame stood in for a `result` that never came.
    const lost = started();
    for (const frame of [replyStart('msg_1'), blockStart(0), textDelta(0, 'All of it.')]) feed(lost, frame);
    if (lost.state.turn !== null) lost.state.turn.stopped = true;
    feed(lost, frameOf('msg_1', 'u-1', { type: 'text', text: 'All of it.' }));
    feed(lost, { type: 'command_lifecycle', command_uuid: 'p', state: 'completed' });
    expect(messages(lost).map((message) => message.itemId)).toEqual(['msg_1#0']);
    expect(lost.ends()[0]).toMatchObject({ outcome: 'completed', answerItemId: 'msg_1#0', lost: true });
  });

  it('names a text as the turn’s answer from its first words: a completed end names the streamed message though its frame never came (C13, C74)', () => {
    const played = started();
    for (const frame of [replyStart('msg_1'), blockStart(0)]) feed(played, frame);
    // Opened, and still empty: nothing to name yet.
    expect(played.state.turn?.lastText).toBeNull();
    feed(played, textDelta(0, 'The answer, as far as it'));
    expect(played.state.turn?.lastText).toBe('msg_1#0');
    feed(played, { type: 'result', is_error: false });
    expect(played.ends()).toEqual([{ type: 'turn-ended', outcome: 'completed', answerItemId: 'msg_1#0', lost: false, detail: null }]);
    expect(messages(played)).toEqual([]);
    // An earlier text stays commentary: the later one is the answer.
    const two = started();
    for (const frame of [replyStart('msg_1'), blockStart(0), textDelta(0, 'First.'), frameOf('msg_1', 'u-1', { type: 'text', text: 'First.' }), replyStart('msg_2'), blockStart(0), textDelta(0, 'Second'), { type: 'result', is_error: false }]) feed(two, frame);
    expect(two.ends()[0]).toMatchObject({ outcome: 'completed', answerItemId: 'msg_2#0' });
  });

  it('forgets a reply at its end, at another reply’s start and at the turn’s end: a later frame of it is whole, and its deltas open nothing', () => {
    const next = started();
    for (const frame of [replyStart('msg_1'), blockStart(0), textDelta(0, 'Half'), replyStart('msg_2'), textDelta(0, ' lost'), frameOf('msg_1', 'u-1', { type: 'text', text: 'Half lost' })]) feed(next, frame);
    expect(next.drops).toEqual(['unopened-item']);
    expect(messages(next).map((message) => message.itemId)).toEqual(['u-1']);
    // The turn's end, and the next turn's start, leave no reply behind.
    const ended = started();
    for (const frame of [replyStart('msg_1'), blockStart(0), textDelta(0, 'Half')]) feed(ended, frame);
    expect(ended.state.reply?.id).toBe('msg_1');
    feed(ended, { type: 'result', is_error: false });
    expect(ended.state.reply).toBeNull();
    feed(ended, replyStart('msg_9'));
    feed(ended, textDelta(0, 'of no turn'));
    expect(ended.drops).toEqual(['other-turn', 'other-turn']);
    expect(ended.state.reply).toBeNull();
    const begun = started();
    for (const frame of [replyStart('msg_1'), blockStart(0)]) feed(begun, frame);
    beginChatTurn(begun.state, RUNTIME(2), 'p2');
    expect(begun.state.reply).toBeNull();
  });

  it('passes over what it does not read without a count, and drops what it cannot take: an event of no known type, a block with no index', () => {
    const played = started();
    const before = played.order.length;
    for (const frame of [
      stream({ type: 'ping' }), stream({ type: 'content_block_stop', index: 0 }), stream({ type: 'message_delta', delta: {} }),
      stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'private' } }),
      stream({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } }),
      stream({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } }),
      stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'a worker’s' } }, { parent_tool_use_id: 'tool-1' }),
      stream({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }, { parent_tool_use_id: 'tool-1' }),
    ]) feed(played, frame);
    expect(played.order.slice(before)).toEqual([]);
    expect(played.drops).toEqual([]);
    expect(played.unread).toBe(0);
    for (const frame of [
      { type: 'stream_event' }, { type: 'stream_event', event: 'not an event' }, stream({ type: 'x'.repeat(65) }),
      stream({ type: 'content_block_start', content_block: { type: 'text' } }), stream({ type: 'content_block_start', index: 64, content_block: { type: 'text' } }), stream({ type: 'content_block_start', index: 1.5, content_block: { type: 'text' } }),
      stream({ type: 'content_block_delta', index: -1, delta: { type: 'text_delta', text: 'x' } }),
    ]) feed(played, frame);
    expect(played.drops).toEqual(['invalid', 'invalid', 'invalid', 'invalid', 'invalid', 'invalid', 'invalid']);
    expect(JSON.stringify(played.events)).not.toContain('private');
    valid(played);
  });

  it('drops a reply’s events when no turn of a prompt’s is in flight, and opens nothing for a reply whose id could not be one', () => {
    const idle = blank(newChatMapper(FOLDER, false));
    for (const frame of [replyStart('msg_1'), blockStart(0), textDelta(0, 'no turn')]) feed(idle, frame);
    expect(idle.drops).toEqual(['other-turn', 'other-turn', 'other-turn']);
    expect(idle.events).toEqual([]);
    // A reply id that is none — too long, or with a line break — opens no reply: its text is whole, under its frame's own id.
    for (const id of ['x'.repeat(300), 'a\nb']) {
      const played = started();
      for (const frame of [replyStart(id), blockStart(0), textDelta(0, 'Hello'), frameOf(id, 'u-1', { type: 'text', text: 'Hello' })]) feed(played, frame);
      expect(deltas(played)).toEqual([]);
      expect(messages(played).map((message) => message.itemId)).toEqual(['u-1']);
      valid(played);
    }
    // One whose id leaves no room for the block's index is treated the same.
    const long = started();
    for (const frame of [replyStart('m'.repeat(255)), blockStart(0), textDelta(0, 'Hello'), frameOf('m'.repeat(255), 'u-1', { type: 'text', text: 'Hello' })]) feed(long, frame);
    expect(deltas(long)).toEqual([]);
    expect(messages(long).map((message) => message.itemId)).toEqual(['u-1']);
    valid(long);
  });

  it('cuts a delta to a message’s bound, and passes an empty one by', () => {
    const played = started();
    for (const frame of [replyStart('msg_1'), blockStart(0), textDelta(0, ''), textDelta(0, 'x'.repeat(MAX_MESSAGE_TEXT + 50))]) feed(played, frame);
    expect(deltas(played).map((delta) => delta.text.length)).toEqual([0, MAX_MESSAGE_TEXT]);
    valid(played);
  });
});

// M20a, V4 (C7, C9, C10, C12, C17, C18, C20, C22, C23, C25): what a session does between its messages.
describe('activities (M20a: V4)', () => {
  let made = 0;
  /** A mapping state with a prompt's turn in flight, as a session leaves it once the CLI took the prompt. */
  const inTurn = (): Played => {
    const state = newChatMapper(FOLDER, true);
    beginChatTurn(state, RUNTIME(1), 'prompt-1');
    const played = blank(state);
    feed(played, { type: 'command_lifecycle', command_uuid: 'prompt-1', state: 'started' });
    played.events.length = 0;
    return played;
  };
  /** Frames made here from the SDK's types, for what no capture holds (C10, C12, C17). */
  const assistant = (content: Json[], parent: string | null = null, replyId = 'message-1'): Json => ({ type: 'assistant', uuid: `uuid-${++made}`, parent_tool_use_id: parent, message: { id: replyId, model: 'claude-sonnet-5', content } });
  const use = (id: string, name: string, input: Json = {}): Json => ({ type: 'tool_use', id, name, input });
  const answered = (blocks: unknown[], parent: string | null = null): Json => ({ type: 'user', parent_tool_use_id: parent, message: { role: 'user', content: blocks }, tool_use_result: { private: 'never read' } });
  const result = (id: string, content: unknown, isError = false): Json => ({ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) });
  const task = (subtype: string, taskId: string, extra: Json = {}): Json => ({ type: 'system', subtype, task_id: taskId, ...extra });
  const stream = (event: Json, parent: string | null = null): Json => ({ type: 'stream_event', parent_tool_use_id: parent, event });
  const frames = (name: string, type: string) => load(name).filter((entry) => entry.dir === 'recv' && entry.frame['type'] === type);

  describe('a tool’s use and its result, per capture (C17, C18)', () => {
    const played = play('m16-t1-basic');
    const [useFrame] = frames('m16-t1-basic', 'assistant');
    const block = at(useFrame?.frame, 'message', 'content', 0) as Json;
    const resultBlock = at(frames('m16-t1-basic', 'user')[0]?.frame, 'message', 'content', 0) as Json;

    it('opens an activity at the `tool_use` block, by the tool’s name, under the tool use’s own id: its input as JSON text, and the file it names', () => {
      expect(starts(played)).toEqual([{
        type: 'activity-started', turnId: RUNTIME(1), itemId: block['id'], activityType: 'read', name: 'Read', summary: 'sample.txt',
        input: JSON.stringify(block['input'], null, 2), files: [{ path: at(block, 'input', 'file_path'), line: null }],
      }]);
      valid(played);
    });

    it('ends it at the `tool_result` block that names it: its content the output, and completed', () => {
      expect(ends(played)).toEqual([{ type: 'activity-ended', turnId: RUNTIME(1), itemId: resultBlock['tool_use_id'], status: 'completed', output: resultBlock['content'] }]);
      expect(resultBlock['tool_use_id']).toBe(block['id']);
      expect(played.state.turn?.tools.size).toBe(0);
      // No duration of the provider's: the span is fat-g's own, between the two frames (C7).
      expect(ends(played)[0]?.durationMs).toBeUndefined();
    });

    it('keeps the action line and the messages as M16 has them: the same order of what the summary is told', () => {
      expect(played.order).toEqual(['turn-started', 'in-force', 'session-started', 'message', 'end:completed']);
      const at0 = played.events.findIndex((event) => event.type === 'activity-started');
      expect(played.events[at0 + 1]).toMatchObject({ type: 'action-changed', kind: 'reading', file: 'sample.txt' });
    });
  });

  describe('each tool, by its name (C17)', () => {
    const start = (name: string, input: Json = {}) => {
      const played = inTurn();
      feed(played, assistant([use('tool-1', name, input)]));
      valid(played);
      return starts(played)[0];
    };

    it.each([
      ['Read', 'read'], ['Glob', 'search'], ['Grep', 'search'], ['Bash', 'command'], ['Write', 'edit'], ['Edit', 'edit'], ['MultiEdit', 'edit'], ['NotebookEdit', 'edit'],
      ['WebSearch', 'web-search'], ['WebFetch', 'web-search'], ['TodoWrite', 'checklist'], ['Agent', 'worker'], ['Task', 'worker'], ['mcp__docs__search', 'mcp'],
      ['ALaterTool', 'other'],
    ] as const)('%s is %s', (name, type) => {
      expect(start(name)?.activityType).toBe(type);
    });

    it('a read names its file with its offset as the line, and a search its pattern and the path it searched', () => {
      expect(start('Read', { file_path: 'C:\\work\\notes\\tide.txt', offset: 40, limit: 20 })).toMatchObject({ summary: 'tide.txt', files: [{ path: 'C:\\work\\notes\\tide.txt', line: 40 }] });
      expect(start('Read', { file_path: 'a.md', offset: 0 })).toMatchObject({ files: [{ path: 'a.md', line: null }] });
      expect(start('Grep', { pattern: 'nextHighTide', path: 'src' })).toMatchObject({ summary: 'nextHighTide', files: [{ path: 'src', line: null }] });
      const glob = start('Glob', { pattern: '**/*.md' });
      expect(glob).toMatchObject({ summary: '**/*.md' });
      expect(glob?.files).toBeUndefined();
    });

    it('a command’s line is its command’s first line, and its input the whole of it', () => {
      const command = start('Bash', { command: 'git status\ngit log -1', description: 'Look at the tree' });
      expect(command).toMatchObject({ activityType: 'command', name: 'Bash', summary: 'git status' });
      expect(JSON.parse(command?.input ?? '{}')).toEqual({ command: 'git status\ngit log -1', description: 'Look at the tree' });
    });

    it('an edit carries its changes on the started event: a Write its content, an Edit and a MultiEdit the text each puts in, a NotebookEdit its source', () => {
      expect(start('Write', { file_path: 'notes/new.md', content: '# New\n' })).toMatchObject({ summary: 'new.md', files: [{ path: 'notes/new.md', line: null }], changes: [{ path: 'notes/new.md', kind: 'write', text: '# New\n' }] });
      expect(start('Edit', { file_path: 'src/tides.js', old_string: 'return 1', new_string: 'return 2' })).toMatchObject({ summary: 'tides.js', changes: [{ path: 'src/tides.js', kind: 'update', text: 'return 2' }] });
      expect(start('MultiEdit', { file_path: 'a.ts', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] })?.changes).toEqual([{ path: 'a.ts', kind: 'update', text: 'b' }, { path: 'a.ts', kind: 'update', text: 'd' }]);
      expect(start('NotebookEdit', { notebook_path: 'n.ipynb', new_source: 'print(1)', edit_mode: 'insert' })?.changes).toEqual([{ path: 'n.ipynb', kind: 'add', text: 'print(1)' }]);
      expect(start('NotebookEdit', { notebook_path: 'n.ipynb', new_source: '', edit_mode: 'delete' })?.changes).toEqual([{ path: 'n.ipynb', kind: 'delete', text: '' }]);
      expect(start('NotebookEdit', { notebook_path: 'n.ipynb', new_source: 'x', edit_mode: 'replace' })?.changes?.[0]?.kind).toBe('update');
      // The whole input is there too, as reported: fat-g computes no diff.
      expect(JSON.parse(start('Edit', { file_path: 'a', old_string: 'x', new_string: 'y' })?.input ?? '{}')).toEqual({ file_path: 'a', old_string: 'x', new_string: 'y' });
    });

    it('a TodoWrite is a checklist: each step’s text and state, on the started event', () => {
      const todos = [{ content: 'List files', status: 'completed', activeForm: 'Listing' }, { content: 'Read README', status: 'in_progress' }, { content: 'Count lines', status: 'pending' }, { content: 'Odd', status: 'aLaterStatus' }];
      expect(start('TodoWrite', { todos })?.steps).toEqual([{ text: 'List files', state: 'completed' }, { text: 'Read README', state: 'in-progress' }, { text: 'Count lines', state: 'pending' }, { text: 'Odd', state: 'pending' }]);
    });

    it('a tool of the user’s configuration is `mcp`, its server and its tool split from its name', () => {
      expect(start('mcp__docs__search', { query: 'tides' })).toMatchObject({ activityType: 'mcp', name: 'docs: search', summary: 'docs: search' });
      expect(start('mcp__my_server__get__all')).toMatchObject({ name: 'my_server: get__all' });
      expect(JSON.parse(start('mcp__docs__search', { query: 'tides' })?.input ?? '{}')).toEqual({ query: 'tides' });
    });

    it('a web search is its query, a fetch its address, and a worker’s line the description it was handed', () => {
      expect(start('WebSearch', { query: 'tide tables' })).toMatchObject({ summary: 'tide tables' });
      expect(start('WebFetch', { url: 'https://example.test/tides', prompt: 'Summarise' })).toMatchObject({ summary: 'https://example.test/tides' });
      expect(start('Agent', { description: 'Read notes-3.txt contents', prompt: 'Read the file.' })).toMatchObject({ activityType: 'worker', name: 'Agent', summary: 'Read notes-3.txt contents' });
    });

    it('a tool it does not know is `other`, by the provider’s name, with its input kept', () => {
      const other = start('ALaterTool', { anything: [1, 2] });
      expect(other).toMatchObject({ activityType: 'other', name: 'ALaterTool', summary: '' });
      expect(JSON.parse(other?.input ?? '{}')).toEqual({ anything: [1, 2] });
    });

    it('cuts an input past its bound, and says so: the event passes its schema', () => {
      const played = inTurn();
      feed(played, assistant([use('tool-1', 'Bash', { command: 'x'.repeat(30_000) })]));
      expect(starts(played)[0]?.input).toHaveLength(10_000);
      expect(starts(played)[0]?.summary).toHaveLength(2_000);
      expect(starts(played)[0]?.cut?.fields).toEqual(['summary', 'input']);
      valid(played);
    });

    it('opens a tool’s use once, and makes none of a block with no id or no name', () => {
      const played = inTurn();
      const frame = assistant([use('tool-1', 'Read', { file_path: 'a.md' })]);
      feed(played, frame);
      feed(played, frame);
      feed(played, assistant([{ type: 'tool_use', name: 'Read', input: {} }, { type: 'tool_use', id: 'tool-2', input: {} }, { type: 'tool_use', id: 'x'.repeat(300), name: 'Read', input: {} }]));
      expect(starts(played).map((event) => event.itemId)).toEqual(['tool-1']);
    });
  });

  describe('a tool’s result (C18)', () => {
    const ended = (content: unknown, isError = false) => {
      const played = inTurn();
      feed(played, assistant([use('tool-1', 'Read', { file_path: 'a.md' })]));
      feed(played, answered([result('tool-1', content, isError)]));
      valid(played);
      return { played, end: ends(played)[0] };
    };

    it('takes a string as it is', () => {
      expect(ended('1\tNote one.\n2\t').end).toEqual({ type: 'activity-ended', turnId: RUNTIME(1), itemId: 'tool-1', status: 'completed', output: '1\tNote one.\n2\t' });
    });

    it('joins an array’s text blocks by a blank line: the captured `Agent` result is two text blocks (m19-t3-subagent)', () => {
      const captured = at(frames('m19-t3-subagent', 'user').find((entry) => Array.isArray(at(entry.frame, 'message', 'content', 0, 'content')))?.frame, 'message', 'content', 0, 'content') as { type: string; text: string }[];
      expect(captured.map((block) => block.type)).toEqual(['text', 'text']);
      const { end } = ended(captured);
      expect(end?.output).toBe(`${captured[0]?.text}\n\n${captured[1]?.text}`);
    });

    it('puts a placeholder line in the place of an image or any other block', () => {
      const { end } = ended([{ type: 'text', text: 'A screenshot:' }, { type: 'image', source: { type: 'base64', data: 'AAAA' } }, { type: 'resource', resource: { uri: 'ui://x' } }, { type: 'a_later_block', data: 'BBBB' }, 'not a block']);
      expect(end?.output).toBe('A screenshot:\n\n[An image, which fat-g does not show.]\n\n[A resource, which fat-g does not show.]\n\n[Content of a kind fat-g does not show.]\n\n[Content of a kind fat-g does not show.]');
      expect(JSON.stringify(end)).not.toMatch(/AAAA|BBBB/);
    });

    it('fails the activity on its error flag: a tool the CLI reports as not found, and one it refused', () => {
      const { end } = ended('Error: No such tool available: Bash', true);
      expect(end).toMatchObject({ status: 'failed', output: 'Error: No such tool available: Bash' });
      // The captured turn's last read, which the Stop rejected.
      const stopped = play('m16-t4-interrupt');
      expect(ends(stopped)).toMatchObject([{ status: 'failed' }]);
    });

    it('cuts an output past its bound to its first and last half, and says so', () => {
      const { end } = ended(`${'a'.repeat(12_000)}${'m'.repeat(7)}${'z'.repeat(12_000)}`);
      expect(end?.output).toBe(`${'a'.repeat(10_000)}${'z'.repeat(10_000)}`);
      expect(end?.cut).toEqual({ fields: ['output'], output: { omitted: 4_007, at: 10_000 }, files: 0, steps: 0, changes: 0 });
    });

    it('gives nothing but tool results of a `user` frame: its text blocks make no message, and its other fields are never read', () => {
      const played = inTurn();
      feed(played, assistant([use('tool-1', 'Read', { file_path: 'a.md' })]));
      played.events.length = 0;
      feed(played, answered([{ type: 'text', text: 'PRIVATE text block' }, result('tool-1', 'the output'), { type: 'text', text: '[Request interrupted by user]' }]));
      expect(played.events).toEqual([{ type: 'activity-ended', turnId: RUNTIME(1), itemId: 'tool-1', status: 'completed', output: 'the output' }, { type: 'action-changed', turnId: RUNTIME(1), kind: 'thinking' }]);
      expect(JSON.stringify(played.events)).not.toMatch(/PRIVATE|never read|interrupted/);
    });

    it('drops and counts a result that names no open item, and one that comes with no turn in flight', () => {
      const played = inTurn();
      feed(played, assistant([use('tool-1', 'Read', { file_path: 'a.md' })]));
      feed(played, answered([result('never-opened', 'x'), result('tool-1', 'y')]));
      expect(played.drops).toEqual(['unopened-item']);
      expect(ends(played).map((event) => event.itemId)).toEqual(['tool-1']);
      // The same result again ends nothing twice.
      feed(played, answered([result('tool-1', 'y')]));
      expect(played.drops).toEqual(['unopened-item', 'unopened-item']);
      const idle = blank(newChatMapper(FOLDER, false));
      feed(idle, answered([result('tool-1', 'y')]));
      expect(idle.drops).toEqual(['other-turn']);
      expect(idle.events).toEqual([]);
    });

    it('takes no id that could be none', () => {
      const played = inTurn();
      feed(played, answered([result('', 'x'), result('x'.repeat(300), 'x'), { type: 'tool_result', content: 'x' }]));
      // No tool result with an id that is one: the frame is not read, as one with none.
      expect(played.unread).toBe(1);
      expect(played.drops).toEqual([]);
    });
  });

  describe('thinking (C9, C17)', () => {
    const thinkingStart = (index: number, parent: string | null = null): Json => stream({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } }, parent);
    const replyStart = (id: string, parent: string | null = null): Json => stream({ type: 'message_start', message: { id, model: 'claude-sonnet-5' } }, parent);

    it('is an item opened at its `content_block_start`, under its reply’s id and the block’s index, and completed whole by the frame that carries it (m19-t4-interrupt)', () => {
      const played = play('m19-t4-interrupt');
      const [frame] = frames('m19-t4-interrupt', 'assistant');
      const itemId = `${String(at(frame?.frame, 'message', 'id'))}#0`;
      const thinking = starts(played).filter((event) => event.activityType === 'thinking');
      expect(thinking).toEqual([{ type: 'activity-started', turnId: RUNTIME(1), itemId, activityType: 'thinking', name: 'thinking', summary: '' }]);
      // The installed CLI sends the block with an empty text and a signature: the item has none, and nothing is made up.
      expect(at(frame?.frame, 'message', 'content', 0)).toMatchObject({ type: 'thinking', thinking: '' });
      expect(ends(played).find((event) => event.itemId === itemId)).toEqual({ type: 'activity-ended', turnId: RUNTIME(1), itemId, status: 'completed' });
      // Its duration is the span between the two, which main measures: the end says none, and is not untimed.
      const opened = played.events.findIndex((event) => event.type === 'activity-started' && event.itemId === itemId);
      const closed = played.events.findIndex((event) => event.type === 'activity-ended' && event.itemId === itemId);
      expect(closed).toBeGreaterThan(opened);
      valid(played);
    });

    it('is a thinking item with no text in every capture that holds one: the CLI sends none', () => {
      for (const name of ['m19-t1-basic', 'm19-t3-subagent', 'm19-t4-interrupt', 'm19-markdown', 'm19b-line', 'm19b-readme', 'm19b-space', 'm16-t3-subagent', 'm16-t4-interrupt']) {
        const played = play(name);
        const thinking = new Set(starts(played).filter((event) => event.activityType === 'thinking').map((event) => event.itemId));
        for (const event of [...starts(played), ...ends(played)]) if (thinking.has(event.itemId)) expect(event.thinking, name).toBeUndefined();
        valid(played);
      }
    });

    it('holds the block’s text where the CLI sends one, as it sent it', () => {
      const played = inTurn();
      for (const frame of [replyStart('msg_1'), thinkingStart(0), assistant([{ type: 'thinking', thinking: 'The tide table first.', signature: 'PRIVATE-SIGNATURE' }], null, 'msg_1')]) feed(played, frame);
      expect(starts(played)).toEqual([{ type: 'activity-started', turnId: RUNTIME(1), itemId: 'msg_1#0', activityType: 'thinking', name: 'thinking', summary: '' }]);
      expect(ends(played)).toEqual([{ type: 'activity-ended', turnId: RUNTIME(1), itemId: 'msg_1#0', status: 'completed', thinking: 'The tide table first.' }]);
      expect(JSON.stringify(played.events)).not.toContain('PRIVATE-SIGNATURE');
      valid(played);
    });

    it('is made whole by its frame where no start event came, and says that no duration is to be measured for it', () => {
      const played = inTurn();
      const frame = assistant([{ type: 'thinking', thinking: '', signature: 's' }]);
      feed(played, frame);
      const itemId = `${String(frame['uuid'])}#thinking`;
      expect(played.events.filter(isWork)).toEqual([
        { type: 'activity-started', turnId: RUNTIME(1), itemId, activityType: 'thinking', name: 'thinking', summary: '' },
        { type: 'activity-ended', turnId: RUNTIME(1), itemId, status: 'completed', untimed: true },
      ]);
      valid(played);
    });

    it('leaves the thinking, signature and tool-input deltas unread: none becomes an event, a drop or an unread frame', () => {
      const played = inTurn();
      feed(played, replyStart('msg_1'));
      feed(played, thinkingStart(0));
      const before = played.events.length;
      for (const delta of [{ type: 'thinking_delta', thinking: 'PRIVATE thought' }, { type: 'signature_delta', signature: 'PRIVATE' }, { type: 'input_json_delta', partial_json: '{"PRIVATE"' }]) feed(played, stream({ type: 'content_block_delta', index: 0, delta }));
      expect(played.events).toHaveLength(before);
      expect(played.drops).toEqual([]);
      expect(played.unread).toBe(0);
    });

    it('still sets the action line to thinking at its frame, as M16 has it', () => {
      const played = inTurn();
      feed(played, assistant([{ type: 'thinking', thinking: '', signature: 's' }]));
      expect(actions(played)).toEqual([]);
      expect(played.state.turn?.kind).toBe('thinking');
    });
  });

  describe('a worker, its item and its frames (C20, C22, C23)', () => {
    /**
     * A capture taken before prompts carried an id (M16, C79): it holds no `command_lifecycle` frame,
     * so its received frames are fed to a turn already in flight, which is what they were.
     */
    const idless = (name: string, change: (frame: Json) => Json | null = (frame) => frame): Played => {
      const into = inTurn();
      for (const entry of load(name)) {
        if (entry.dir !== 'recv' || entry.frame['type'] === 'control_response') continue;
        const changed = change(entry.frame);
        if (changed !== null) feed(into, changed);
      }
      return into;
    };
    const played = idless('m16-background-disabled');
    const worker = '<worker-13>';
    const launch = '<tool-use-10>';
    const notification = frames('m16-background-disabled', 'system').find((entry) => entry.frame['subtype'] === 'task_notification')?.frame as Json;
    const workItems = played.events.filter(isWork);

    it('fails the captured launch that never started a worker: a worker item with its error as output, and no worker id', () => {
      const failed = '<tool-use-5>';
      expect(starts(played).filter((event) => event.itemId === failed)).toMatchObject([{ activityType: 'worker', name: 'Agent' }]);
      expect(starts(played).some((event) => event.itemId === failed && event.pairedWorkerId !== undefined)).toBe(false);
      expect(ends(played).filter((event) => event.itemId === failed)).toEqual([{ type: 'activity-ended', turnId: RUNTIME(1), itemId: failed, status: 'failed', output: expect.stringContaining('Cannot create agent worktree') as string }]);
      // No worker ever opened for it.
      expect(ofType(played, 'worker-started').map((event) => event.workerId)).toEqual([worker]);
    });

    it('pairs the `Agent` tool use with its worker at `task_started`: a second start for the same item, which names the worker and opens nothing', () => {
      const own = starts(played).filter((event) => event.itemId === launch);
      expect(own).toHaveLength(3);
      expect(own[0]?.pairedWorkerId).toBeUndefined();
      expect(own[1]).toEqual({ type: 'activity-started', turnId: RUNTIME(1), itemId: launch, activityType: 'worker', name: 'Agent', summary: own[0]?.summary, pairedWorkerId: worker, agentType: 'general-purpose' });
      // Its first frame names the model it runs on (M106, C14): a third start says it, and opens nothing.
      expect(own[2]).toEqual({ type: 'activity-started', turnId: RUNTIME(1), itemId: launch, activityType: 'worker', name: 'Agent', summary: own[0]?.summary, pairedWorkerId: worker, model: 'claude-sonnet-5' });
      // After the list was told of the worker: main names the item as the list names it.
      const startedAt = played.events.findIndex((event) => event.type === 'worker-started');
      expect(played.events[startedAt + 1]).toBe(own[1]);
    });

    it('gives the worker’s frames as its items under its id, in the turn that started it: ten reads, each opened and ended, then its report', () => {
      const workers = workItems.filter((event) => 'workerId' in event && event.workerId === worker);
      expect(workers.map((event) => event.type)).toEqual([...Array.from({ length: 10 }, () => ['activity-started', 'activity-ended']).flat(), 'message']);
      expect(workers.every((event) => 'turnId' in event && event.turnId === RUNTIME(1))).toBe(true);
      expect(workers[0]).toMatchObject({ activityType: 'read', name: 'Read', summary: 'notes-1.txt' });
      expect(workers[1]).toMatchObject({ status: 'completed', output: expect.stringContaining('tide table') as string });
      // Its instruction, a text block of a `user` frame, is no message; its one message is its report (M106, C45).
      expect(played.events.filter((event) => event.type === 'message' && event.workerId !== undefined).map((event) => 'itemId' in event && event.itemId)).toEqual([`${worker}#report`]);
      expect(JSON.stringify(played.events.filter((event) => event.type !== 'activity-started' || event.activityType !== 'worker'))).not.toContain('in this exact order');
      expect(played.drops).toEqual([]);
      valid(played);
    });

    it('ends the worker item as its worker ends, and gives it its notification’s summary and duration, and nothing from its `tool_result`', () => {
      const own = ends(played).filter((event) => event.itemId === launch);
      // `task_updated` ends the worker, and so its item; the notification that follows brings the report and the CLI's own duration.
      expect(own).toEqual([
        { type: 'activity-ended', turnId: RUNTIME(1), itemId: launch, status: 'completed' },
        { type: 'activity-ended', turnId: RUNTIME(1), itemId: launch, status: 'completed', output: notification['summary'], durationMs: at(notification, 'usage', 'duration_ms') },
      ]);
      const first = played.events.indexOf(own[0] as AgentEvent);
      expect(played.events[first + 1]).toEqual({ type: 'worker-ended', workerId: worker, outcome: 'completed' });
      // Its result holds the agent's id and the CLI's own usage lines beside the report: none of that is the item's.
      expect(JSON.stringify(own)).not.toMatch(/agentId|subagent_tokens|SendMessage/);
      expect(ofType(played, 'worker-ended')).toHaveLength(1);
    });

    it('takes a notification that comes first as the one end, with its report and duration at once', () => {
      const reordered = idless('m16-background-disabled', (frame) => (frame['subtype'] === 'task_updated' ? null : frame));
      expect(ends(reordered).filter((event) => event.itemId === launch)).toEqual([{ type: 'activity-ended', turnId: RUNTIME(1), itemId: launch, status: 'completed', output: notification['summary'], durationMs: at(notification, 'usage', 'duration_ms') }]);
      const failed = idless('m16-background-disabled', (frame) => (frame['subtype'] === 'task_updated' ? null : frame['subtype'] === 'task_notification' ? { ...frame, status: 'failed' } : frame));
      expect(ends(failed).find((event) => event.itemId === launch)?.status).toBe('failed');
      expect(ofType(failed, 'worker-ended')).toEqual([{ type: 'worker-ended', workerId: worker, outcome: 'failed' }]);
    });

    // M106 (C45): a worker in the foreground sends none of its text in its frames — the capture's
    // ten reads come with no text — so its report, the notification's summary, is its last message.
    it('gives a worker that sent no text its report as its last message, by whichever closing frame brings it: commentary, under its id, before its item’s end', () => {
      const report = { type: 'message', turnId: RUNTIME(1), role: 'assistant', itemId: `${worker}#report`, phase: 'commentary', text: notification['summary'], workerId: worker };
      // `task_updated` ended it first: the notification that follows brings the report, then the item's output.
      const later = played.events.findIndex((event) => event.type === 'message' && event.workerId === worker);
      expect(played.events[later]).toEqual(report);
      expect(played.events[later + 1]).toMatchObject({ type: 'activity-ended', itemId: launch, output: notification['summary'] });
      // The notification first: the report, then the item's end, then the list's.
      const reordered = idless('m16-background-disabled', (frame) => (frame['subtype'] === 'task_updated' ? null : frame));
      const first = reordered.events.findIndex((event) => event.type === 'message' && event.workerId === worker);
      expect(reordered.events.slice(first, first + 3).map((event) => event.type)).toEqual(['message', 'activity-ended', 'worker-ended']);
      expect(reordered.events[first]).toEqual(report);
      valid(reordered);
    });

    it('gives no report as a message where the worker sent a text of its own, or its notification says nothing', () => {
      const own = inTurn();
      feed(own, assistant([use('agent-1', 'Agent', { description: 'Reads notes' })]));
      feed(own, task('task_started', 'task-1', { tool_use_id: 'agent-1' }));
      feed(own, assistant([{ type: 'text', text: 'The file holds one line.' }], 'agent-1'));
      feed(own, task('task_notification', 'task-1', { tool_use_id: 'agent-1', status: 'completed', summary: 'The file holds one line.' }));
      expect(own.events.filter((event) => event.type === 'message' && event.workerId === 'task-1').map((event) => 'text' in event && event.text)).toEqual(['The file holds one line.']);
      const silent = inTurn();
      feed(silent, assistant([use('agent-1', 'Agent', { description: 'Reads notes' })]));
      feed(silent, task('task_started', 'task-1', { tool_use_id: 'agent-1' }));
      feed(silent, task('task_notification', 'task-1', { tool_use_id: 'agent-1', status: 'completed', summary: '  ' }));
      expect(silent.events.some((event) => event.type === 'message')).toBe(false);
      valid(own);
      valid(silent);
    });

    it('keeps the summary as it was: the same events for the list, with and without the worker’s items', () => {
      expect(ofType(played, 'worker-started')).toHaveLength(1);
      expect(ofType(played, 'worker-progressed').every((event) => event.workerId === worker && (event.kind === 'reading' || event.kind === 'thinking'))).toBe(true);
      // The session's answer is its own: no worker's frame named it.
      expect(played.ends()).toMatchObject([{ outcome: 'completed', answerItemId: at(frames('m16-background-disabled', 'assistant').at(-1)?.frame, 'uuid') }]);
    });

    it('gives a worker’s text as its message, never the turn’s answer, the action line or the commentary', () => {
      const made0 = inTurn();
      feed(made0, assistant([{ type: 'text', text: 'Handing it over.' }]));
      feed(made0, assistant([use('agent-1', 'Agent', { description: 'Reads notes' })]));
      feed(made0, task('task_started', 'task-1', { tool_use_id: 'agent-1', description: 'Reads notes' }));
      const before = actions(made0).length;
      const workers = assistant([{ type: 'text', text: 'The file holds one line.' }], 'agent-1');
      feed(made0, workers);
      expect(made0.events.at(-1)).toEqual({ type: 'message', turnId: RUNTIME(1), role: 'assistant', itemId: workers['uuid'], phase: 'commentary', text: 'The file holds one line.', workerId: 'task-1' });
      expect(actions(made0)).toHaveLength(before);
      expect(made0.state.turn).toMatchObject({ commentary: 'Handing it over.' });
      expect(made0.state.turn?.lastText).not.toBe(workers['uuid']);
      feed(made0, { type: 'result', is_error: false });
      expect(made0.ends()[0]?.answerItemId).not.toBe(workers['uuid']);
      valid(made0);
    });

    it('holds a worker’s frame that comes before its pairing, and takes it once `task_started` pairs it', () => {
      const held = inTurn();
      feed(held, assistant([use('agent-1', 'Agent', { description: 'Reads notes' })]));
      const early = assistant([use('w-tool-1', 'Read', { file_path: 'notes-1.txt' })], 'agent-1');
      feed(held, early);
      feed(held, answered([result('w-tool-1', 'Note one.')], 'agent-1'));
      expect(held.events.filter((event) => 'workerId' in event && event.type !== 'worker-started')).toEqual([]);
      expect(held.effects.filter((effect) => effect.type === 'worker-frame-held')).toEqual([{ type: 'worker-frame-held', parent: 'agent-1' }, { type: 'worker-frame-held', parent: 'agent-1' }]);
      expect(held.state.waiting).toHaveLength(2);
      feed(held, task('task_started', 'task-1', { tool_use_id: 'agent-1' }));
      expect(held.effects.at(-1)).toEqual({ type: 'worker-frames-claimed', parent: 'agent-1' });
      expect(held.state.waiting).toEqual([]);
      // In the order they came, after the worker's start and its item's pairing.
      // Its first frame names its model first (M106, C14).
      expect(held.events.filter((event) => event.type !== 'action-changed' && event.type !== 'worker-progressed').slice(-6).map((event) => [event.type, 'workerId' in event ? event.workerId : null, 'itemId' in event ? event.itemId : null])).toEqual([
        ['worker-started', 'task-1', null], ['activity-started', null, 'agent-1'], ['worker-model', 'task-1', null], ['activity-started', null, 'agent-1'], ['activity-started', 'task-1', 'w-tool-1'], ['activity-ended', 'task-1', 'w-tool-1'],
      ]);
      expect(held.drops).toEqual([]);
      valid(held);
    });

    it('lets go of the frames no pairing claims, for the session to count; holds no more than its bound; and drops one whose parent is no id', () => {
      const lost = inTurn();
      for (let n = 0; n < MAX_WAITING_FRAMES + 3; n += 1) feed(lost, assistant([use(`w-${n}`, 'Read', {})], 'never-paired'));
      expect(lost.state.waiting).toHaveLength(MAX_WAITING_FRAMES);
      expect(lost.drops).toEqual(['other-worker', 'other-worker', 'other-worker']);
      expect(expireWaitingFrames(lost.state, 'another-parent')).toBe(0);
      expect(expireWaitingFrames(lost.state, 'never-paired')).toBe(MAX_WAITING_FRAMES);
      expect(lost.state.waiting).toEqual([]);
      const odd = inTurn();
      feed(odd, assistant([use('w-1', 'Read', {})], 'x'.repeat(300)));
      expect(odd.drops).toEqual(['other-worker']);
      expect(odd.state.waiting).toEqual([]);
    });

    it('changes nothing for a frame of a worker that has ended, and ends every open worker and its item as failed when its turn is stopped or lost', () => {
      const open = inTurn();
      feed(open, assistant([use('agent-1', 'Agent', { description: 'Reads notes' })]));
      feed(open, task('task_started', 'task-1', { tool_use_id: 'agent-1' }));
      feed(open, assistant([use('w-tool-1', 'Read', {})], 'agent-1'));
      expect(failChatWorkers(open.state)).toEqual([{ type: 'activity-ended', turnId: RUNTIME(1), itemId: 'agent-1', status: 'failed' }, { type: 'worker-ended', workerId: 'task-1', outcome: 'failed' }]);
      const before = open.events.length;
      feed(open, answered([result('w-tool-1', 'late')], 'agent-1'));
      feed(open, assistant([{ type: 'text', text: 'late' }], 'agent-1'));
      feed(open, task('task_notification', 'task-1', { tool_use_id: 'agent-1', status: 'completed', summary: 'late' }));
      expect(open.events).toHaveLength(before);
      expect(open.drops).toEqual([]);
    });

    it('ends nothing of a paired worker item at its `tool_result`, and takes a worker’s own stream events as its text, should the CLI send them', () => {
      const made1 = inTurn();
      feed(made1, assistant([use('agent-1', 'Agent', { description: 'Reads notes' })]));
      feed(made1, task('task_started', 'task-1', { tool_use_id: 'agent-1' }));
      for (const frame of [stream({ type: 'message_start', message: { id: 'w-msg', model: 'claude-sonnet-5' } }, 'agent-1'), stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, 'agent-1'), stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'The file' } }, 'agent-1')]) feed(made1, frame);
      feed(made1, assistant([{ type: 'text', text: 'The file holds one line.' }], 'agent-1', 'w-msg'));
      const workers = made1.events.filter((event) => (event.type === 'message' || event.type === 'message-delta') && event.workerId === 'task-1');
      expect(workers.map((event) => [event.type, 'itemId' in event ? event.itemId : null, 'text' in event ? event.text : null])).toEqual([['message-delta', 'w-msg#0', ''], ['message-delta', 'w-msg#0', 'The file'], ['message', 'w-msg#0', 'The file holds one line.']]);
      // The session's own reply is untouched by it: no reference is made of a worker's reply, and no action.
      expect(actions(made1).filter((event) => event.kind === 'writing')).toEqual([]);
      const before = made1.events.length;
      feed(made1, answered([result('agent-1', [{ type: 'text', text: 'The report.' }])]));
      expect(made1.events.slice(before)).toEqual([{ type: 'action-changed', turnId: RUNTIME(1), kind: 'thinking' }]);
      expect(made1.drops).toEqual([]);
      valid(made1);
    });
  });

  it('has no checklist under the launch: no capture holds a `TodoWrite`, which the launch does not offer (C25)', () => {
    for (const name of ['m16-t1-basic', 'm16-t3-subagent', 'm16-t4-interrupt', 'm19-t1-basic', 'm19-t3-subagent', 'm19-t4-interrupt']) {
      const played = play(name);
      expect(starts(played).length, name).toBeGreaterThan(0);
      expect(starts(played).filter((event) => event.activityType === 'checklist'), name).toEqual([]);
    }
  });
});

// ── M21: a question ───────────────────────────────────────────────────────────────────────────
// V4, V21, V28 (docs/planning/_archive/M21.md, Design 3; C11, C19, C21, C62, C63, C65, C72): the question
// tool's use and its result, on K1's captures and on frames made here for what K1 did not see — a
// worker's question. A request is the session's to answer, so each capture is played as the session
// plays it: the request is placed, the spike's own answer marks it answered, an interrupt marks the
// turn stopped, and the CLI's cancel releases it.
describe('a question (M21: V4, V21, V28)', () => {
  let made = 0;
  const inTurn = (): Played => {
    const state = newChatMapper(FOLDER, true);
    beginChatTurn(state, RUNTIME(1), 'prompt-1');
    const played = blank(state);
    feed(played, { type: 'command_lifecycle', command_uuid: 'prompt-1', state: 'started' });
    played.events.length = 0;
    played.order.length = 0;
    return played;
  };
  const assistant = (content: Json[], parent: string | null = null): Json => ({ type: 'assistant', uuid: `q-uuid-${++made}`, parent_tool_use_id: parent, message: { id: 'message-1', model: 'claude-sonnet-5', content } });
  const use = (id: string, name: string, input: Json = {}): Json => ({ type: 'tool_use', id, name, input });
  const QUESTIONS = { questions: [{ question: 'Which private file?', header: 'File', options: [{ label: 'secret-a.txt', description: 'The first' }, { label: 'secret-b.txt', description: 'The second' }], multiSelect: false }] };
  const ask = (id: string, parent: string | null = null): Json => assistant([use(id, 'AskUserQuestion', QUESTIONS)], parent);
  const answered = (id: string, parent: string | null = null, isError = false): Json => ({ type: 'user', parent_tool_use_id: parent, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'Your questions have been answered: "Which private file?"="secret-b.txt".', ...(isError ? { is_error: true } : {}) }] } });
  const task = (subtype: string, taskId: string, extra: Json = {}): Json => ({ type: 'system', subtype, task_id: taskId, ...extra });
  const closed = (played: Played) => played.effects.filter((effect) => effect.type === 'question-closed');
  const resolved = (played: Played) => ofType(played, 'question-resolved');
  /** A turn with a worker open and paired with its `Agent` tool use. */
  const withWorker = (): Played => {
    const played = inTurn();
    feed(played, assistant([use('agent-1', 'Agent', { description: 'Asks, then reads' })]));
    feed(played, task('task_started', 'task-1', { tool_use_id: 'agent-1', description: 'Asks, then reads' }));
    return played;
  };

  /** A question capture, as the session plays it. */
  function playAsked(name: string, options: { readonly change?: (frame: Json) => Json; readonly answer?: boolean } = {}): Played & { readonly placed: (PlacedQuestion | null)[] } {
    const played = { ...blank(newChatMapper(FOLDER, false)), placed: [] as (PlacedQuestion | null)[] };
    const held = new Map<string, { placed: PlacedQuestion; toolUseId: string }>();
    let turn = 0;
    for (const entry of load(name)) {
      const frame = options.change === undefined || entry.dir === 'send' ? entry.frame : options.change(entry.frame);
      if (entry.dir === 'send') {
        if (frame['type'] === 'user' && typeof frame['uuid'] === 'string') beginChatTurn(played.state, RUNTIME(++turn), frame['uuid']);
        if (frame['type'] === 'control_request' && at(frame, 'request', 'subtype') === 'interrupt' && played.state.turn !== null) played.state.turn.stopped = true;
        // The spike's own answer: fat-g wrote an `allow` for the request.
        const answeredFor = frame['type'] === 'control_response' ? held.get(String(at(frame, 'response', 'request_id'))) : undefined;
        if (answeredFor !== undefined && options.answer !== false) questionAnswered(played.state, answeredFor.placed, answeredFor.toolUseId);
        continue;
      }
      if (frame['type'] === 'control_response') continue;
      if (frameKind(frame) === 'request') {
        const asked = takeRequest(frame).question;
        const placed = asked === null || asked.requestId === null || asked.toolUseId === null ? null : placeQuestion(played.state, { requestId: asked.requestId, toolUseId: asked.toolUseId, agentId: asked.agentId });
        played.placed.push(placed);
        if (placed !== null && asked?.requestId != null && asked.toolUseId !== null) held.set(asked.requestId, { placed, toolUseId: asked.toolUseId });
      }
      if (frameKind(frame) === 'cancel') {
        const taken = held.get(String(frame['request_id']));
        if (taken !== undefined) questionReleased(played.state, taken.placed, taken.toolUseId);
      }
      feed(played, frame);
    }
    return played;
  }
  const requestOf = (name: string): Json => load(name).find((entry) => entry.dir === 'recv' && entry.frame['type'] === 'control_request')?.frame as Json;

  describe('the session’s own, per capture (C19, C62, C63)', () => {
    it.each([
      ['m21-question-one', ['read']],
      ['m21-question-multi', ['read', 'read']],
      ['m21-question-two', ['read']],
    ] as const)('%s: the question tool’s use opens no activity, its request is the session’s own, and its result marks the answer confirmed', (name, activities) => {
      const played = playAsked(name);
      valid(played);
      const request = requestOf(name);
      // No activity of the question's: the turn's activities are its reads, each opened and ended.
      expect(starts(played).map((event) => event.activityType)).toEqual(activities);
      expect(ends(played).map((event) => event.status)).toEqual(activities.map(() => 'completed'));
      expect(starts(played).some((event) => event.itemId === at(request, 'request', 'tool_use_id'))).toBe(false);
      // Placed under the prompt's turn, with no worker.
      expect(played.placed).toEqual([{ turnId: RUNTIME(1), workerId: null }]);
      // The result names no open activity, and is no drop: it is the mark, under the request's own id.
      expect(played.drops).toEqual([]);
      expect(resolved(played)).toEqual([{ type: 'question-resolved', requestId: request['request_id'], reason: 'confirmed' }]);
      expect(closed(played)).toEqual([{ type: 'question-closed', requestId: request['request_id'], failed: false }]);
      expect(played.state.turn?.questions.size).toBe(0);
      // Before the read the answer led to, and the turn goes on to its completed end.
      expect(played.events.findIndex((event) => event.type === 'question-resolved')).toBeLessThan(played.events.findIndex((event) => event.type === 'activity-started'));
      expect(played.ends()).toMatchObject([{ outcome: 'completed' }]);
      // Nothing of the question, its options or the answer is in any event of the mapper's: the request is the session's.
      expect(JSON.stringify(played.events)).not.toMatch(/Which |File choice|Notes files|Language|English|French/);
    });

    it('keeps the action line as it was around it: the tool’s use is an action, and nothing of the question is its line', () => {
      const played = playAsked('m21-question-one');
      // But for the answer's text as it is written.
      expect(played.order.filter((kind) => kind !== 'message-delta')).toEqual(['turn-started', 'in-force', 'session-started', 'question-resolved', 'message', 'end:completed']);
      expect(actions(played)[0]).toMatchObject({ kind: 'reading', file: 'notes-2.txt' });
      expect(actions(played)[1]).toMatchObject({ kind: 'thinking' });
    });

    it('says nothing at the result of a request nobody answered, and drops nothing', () => {
      const played = playAsked('m21-question-one', { answer: false });
      expect(resolved(played)).toEqual([]);
      // The request is over all the same: the session is told, with no failure to count.
      expect(closed(played)).toEqual([{ type: 'question-closed', requestId: requestOf('m21-question-one')['request_id'], failed: false }]);
      expect(played.drops).toEqual([]);
    });

    it('marks an answer confirmed whatever its result’s error flag, and says the flag for the session to count (C19)', () => {
      const flagged = playAsked('m21-question-one', { change: (frame) => (frame['type'] === 'user' && at(frame, 'message', 'content', 0, 'tool_use_id') === '<tool-use-10>' ? { ...frame, message: { ...(frame['message'] as Json), content: [{ ...(at(frame, 'message', 'content', 0) as Json), is_error: true }] } } : frame) });
      expect(resolved(flagged)).toEqual([{ type: 'question-resolved', requestId: '<request-31>', reason: 'confirmed' }]);
      expect(closed(flagged)).toEqual([{ type: 'question-closed', requestId: '<request-31>', failed: true }]);
      // It fails nothing: no activity ended as failed, and the turn completes.
      expect(ends(flagged).map((event) => event.status)).toEqual(['completed']);
      expect(flagged.ends()).toMatchObject([{ outcome: 'completed' }]);
      // The flag of a result nobody answered is no failure of an answer.
      const unanswered = playAsked('m21-question-one', { answer: false, change: (frame) => (frame['type'] === 'user' && at(frame, 'message', 'content', 0, 'tool_use_id') === '<tool-use-10>' ? { ...frame, message: { ...(frame['message'] as Json), content: [{ ...(at(frame, 'message', 'content', 0) as Json), is_error: true }] } } : frame) });
      expect(closed(unanswered)).toEqual([{ type: 'question-closed', requestId: '<request-31>', failed: false }]);
    });

    it('K1’s Stop: the cancel releases the request, its error result says nothing more, and the `result` ends the turn interrupted (C20, C22)', () => {
      const played = playAsked('m21-question-stop');
      valid(played);
      expect(played.placed).toEqual([{ turnId: RUNTIME(1), workerId: null }]);
      expect(frameKind(load('m21-question-stop').find((entry) => entry.frame['type'] === 'control_cancel_request')?.frame)).toBe('cancel');
      // The cancel is no frame of the mapper's, and neither question event is its own to say here.
      expect(resolved(played)).toEqual([]);
      expect(closed(played)).toEqual([]);
      expect(played.drops).toEqual([]);
      expect(starts(played)).toEqual([]);
      expect(played.ends()).toEqual([{ type: 'turn-ended', outcome: 'interrupted', answerItemId: null, lost: false, detail: null }]);
      // The CLI's words to the model at the Stop are no message, no notice and no detail.
      expect(JSON.stringify(played.events)).not.toMatch(/doesn't want to proceed|interrupted by user/);
    });

    it('K1’s kill: the request is placed, and nothing follows it', () => {
      const played = playAsked('m21-question-killed-first');
      expect(played.placed).toEqual([{ turnId: RUNTIME(1), workerId: null }]);
      expect(played.state.turn?.questions).toEqual(new Map([['<tool-use-9>', { requestId: '<request-30>', answered: false, declined: false }]]));
      expect(resolved(played)).toEqual([]);
      expect(starts(played)).toEqual([]);
      expect(played.ends()).toEqual([]);
      // And the session resumed after it asks nothing: its one turn is a text.
      const resumed = playAsked('m21-question-killed-resumed');
      expect(resumed.placed).toEqual([]);
      expect(messages(resumed)).toHaveLength(1);
      expect(resumed.ends()).toMatchObject([{ outcome: 'completed' }]);
    });

    it('K1’s worker asked nothing: no request came, and its turn is a worker’s as any (C21)', () => {
      const played = playAsked('m21-question-worker');
      valid(played);
      expect(played.placed).toEqual([]);
      expect(resolved(played)).toEqual([]);
      expect(ofType(played, 'worker-started')).toHaveLength(1);
      expect(ofType(played, 'worker-ended')).toEqual([{ type: 'worker-ended', workerId: '<worker-56>', outcome: 'completed' }]);
      expect(played.drops).toEqual([]);
      expect(played.ends()).toMatchObject([{ outcome: 'completed' }]);
    });
  });

  describe('where a request belongs (C11, C21, C65)', () => {
    it('is the session’s own while the prompt’s turn is in flight, and nowhere before its `started`, after its `result`, or in a turn the CLI started by itself', () => {
      const none = newChatMapper(FOLDER, true);
      expect(placeQuestion(none, { requestId: 'r-0', toolUseId: 'ask-0', agentId: null })).toBeNull();
      // Written, and not yet taken by the CLI.
      beginChatTurn(none, RUNTIME(1), 'prompt-1');
      expect(placeQuestion(none, { requestId: 'r-0', toolUseId: 'ask-0', agentId: null })).toBeNull();
      const played = inTurn();
      expect(placeQuestion(played.state, { requestId: 'r-1', toolUseId: 'ask-1', agentId: null })).toEqual({ turnId: RUNTIME(1), workerId: null });
      feed(played, { type: 'result', is_error: false });
      expect(placeQuestion(played.state, { requestId: 'r-2', toolUseId: 'ask-2', agentId: null })).toBeNull();
      // A turn the CLI started by itself: an `init` no `started` precedes.
      feed(played, { type: 'system', subtype: 'init', session_id: 's', model: 'claude-sonnet-5', tools: ['Read'], permissionMode: 'default' });
      expect(played.state.selfTurn).toBe(true);
      expect(placeQuestion(played.state, { requestId: 'r-3', toolUseId: 'ask-3', agentId: null })).toBeNull();
    });

    it('is a worker’s where it names one that is paired and open, in the turn that started it, with or without a turn of the session’s', () => {
      const played = withWorker();
      expect(placeQuestion(played.state, { requestId: 'r-1', toolUseId: 'w-ask-1', agentId: 'task-1' })).toEqual({ turnId: RUNTIME(1), workerId: 'task-1' });
      expect(played.state.workers.get('task-1')?.questions).toEqual(new Map([['w-ask-1', { requestId: 'r-1', answered: false, declined: false }]]));
      expect(played.state.turn?.questions.size).toBe(0);
      // The parent's turn completes, which ends no worker: a request after it is still the worker's.
      feed(played, { type: 'result', is_error: false });
      expect(placeQuestion(played.state, { requestId: 'r-2', toolUseId: 'w-ask-2', agentId: 'task-1' })).toEqual({ turnId: RUNTIME(1), workerId: 'task-1' });
      // And in the next turn, under the turn that started the worker.
      beginChatTurn(played.state, RUNTIME(2), 'prompt-2');
      feed(played, { type: 'command_lifecycle', command_uuid: 'prompt-2', state: 'started' });
      expect(placeQuestion(played.state, { requestId: 'r-3', toolUseId: 'w-ask-3', agentId: 'task-1' })).toEqual({ turnId: RUNTIME(1), workerId: 'task-1' });
    });

    it('is the session’s own where it names an agent no worker was paired as, and nowhere where it names a worker that has ended', () => {
      const played = withWorker();
      expect(placeQuestion(played.state, { requestId: 'r-1', toolUseId: 'ask-1', agentId: 'no-such-worker' })).toEqual({ turnId: RUNTIME(1), workerId: null });
      feed(played, task('task_notification', 'task-1', { tool_use_id: 'agent-1', status: 'completed', summary: 'Done.' }));
      expect(played.state.workers.size).toBe(0);
      expect(placeQuestion(played.state, { requestId: 'r-2', toolUseId: 'w-ask-2', agentId: 'task-1' })).toBeNull();
      // A worker no tool use is known for is paired with none: its request is the session's own.
      const unpaired = inTurn();
      feed(unpaired, task('task_started', 'task-9', { description: 'Started by nothing fat-g saw' }));
      expect(unpaired.state.workers.get('task-9')?.toolUseId).toBeNull();
      expect(placeQuestion(unpaired.state, { requestId: 'r-3', toolUseId: 'ask-3', agentId: 'task-9' })).toEqual({ turnId: RUNTIME(1), workerId: null });
      // And with no turn in flight, such a request is placed nowhere.
      feed(unpaired, { type: 'result', is_error: false });
      expect(placeQuestion(unpaired.state, { requestId: 'r-4', toolUseId: 'ask-4', agentId: 'no-such-worker' })).toBeNull();
    });

    it('completes the question its tool use opened, opens it where that block never came, and places no second request for one tool use', () => {
      const played = inTurn();
      feed(played, ask('ask-1'));
      expect(played.state.turn?.questions).toEqual(new Map([['ask-1', { requestId: null, answered: false, declined: false }]]));
      expect(placeQuestion(played.state, { requestId: 'r-1', toolUseId: 'ask-1', agentId: null })).not.toBeNull();
      expect(played.state.turn?.questions).toEqual(new Map([['ask-1', { requestId: 'r-1', answered: false, declined: false }]]));
      expect(placeQuestion(played.state, { requestId: 'r-2', toolUseId: 'ask-1', agentId: null })).toBeNull();
      expect(played.state.turn?.questions.get('ask-1')?.requestId).toBe('r-1');
      // The request before its block: the block that follows opens nothing, and no activity.
      expect(placeQuestion(played.state, { requestId: 'r-3', toolUseId: 'ask-2', agentId: null })).not.toBeNull();
      feed(played, ask('ask-2'));
      expect(played.state.turn?.questions.get('ask-2')).toEqual({ requestId: 'r-3', answered: false, declined: false });
      expect(starts(played)).toEqual([]);
      // Released — taken back, or refused — its tool use can be asked again.
      questionReleased(played.state, { turnId: RUNTIME(1), workerId: null }, 'ask-1');
      expect(played.state.turn?.questions.get('ask-1')).toEqual({ requestId: null, answered: false, declined: false });
      expect(placeQuestion(played.state, { requestId: 'r-4', toolUseId: 'ask-1', agentId: null })).not.toBeNull();
    });
  });

  describe('the block and its result, by hand (C19, C63)', () => {
    it('opens no activity for the question tool, once or twice, and still opens one for a tool beside it', () => {
      const played = inTurn();
      feed(played, ask('ask-1'));
      feed(played, ask('ask-1'));
      feed(played, assistant([use('ask-2', 'AskUserQuestion', QUESTIONS), use('tool-1', 'Read', { file_path: 'a.md' })]));
      expect(starts(played).map((event) => [event.itemId, event.activityType])).toEqual([['tool-1', 'read']]);
      expect([...(played.state.turn?.questions.keys() ?? [])]).toEqual(['ask-1', 'ask-2']);
      expect(played.state.turn?.tools.has('ask-1')).toBe(false);
      // Nothing of what it asks is in an event: no input, no summary, no line.
      expect(JSON.stringify(played.events)).not.toMatch(/private|secret-/);
      valid(played);
    });

    it('says nothing at the result of a question no request came for, and nothing after a release: neither is a drop', () => {
      const played = inTurn();
      feed(played, ask('ask-1'));
      feed(played, answered('ask-1', null, true));
      expect([played.events.filter((event) => event.type !== 'action-changed'), played.effects.filter((effect) => effect.type === 'question-closed'), played.drops]).toEqual([[], [], []]);
      expect(played.state.turn?.questions.size).toBe(0);
      // Answered, then taken back by the CLI: its result is no confirmation.
      const taken = inTurn();
      feed(taken, ask('ask-1'));
      const placed = placeQuestion(taken.state, { requestId: 'r-1', toolUseId: 'ask-1', agentId: null }) as PlacedQuestion;
      questionAnswered(taken.state, placed, 'ask-1');
      questionReleased(taken.state, placed, 'ask-1');
      feed(taken, answered('ask-1'));
      expect([resolved(taken), closed(taken), taken.drops]).toEqual([[], [], []]);
      // A second result for it finds no question and no activity: that one is dropped, as any is.
      feed(taken, answered('ask-1'));
      expect(taken.drops).toEqual(['unopened-item']);
    });

    it('reads a result beside a question’s as it did: one frame’s results, each on its own', () => {
      const played = inTurn();
      feed(played, assistant([use('ask-1', 'AskUserQuestion', QUESTIONS), use('tool-1', 'Read', { file_path: 'a.md' })]));
      const placed = placeQuestion(played.state, { requestId: 'r-1', toolUseId: 'ask-1', agentId: null }) as PlacedQuestion;
      questionAnswered(played.state, placed, 'ask-1');
      feed(played, { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ask-1', content: 'answered' }, { type: 'tool_result', tool_use_id: 'tool-1', content: 'One line.' }, { type: 'tool_result', tool_use_id: 'never-opened', content: 'x' }] } });
      expect(resolved(played)).toEqual([{ type: 'question-resolved', requestId: 'r-1', reason: 'confirmed' }]);
      expect(ends(played)).toEqual([{ type: 'activity-ended', turnId: RUNTIME(1), itemId: 'tool-1', status: 'completed', output: 'One line.' }]);
      expect(played.drops).toEqual(['unopened-item']);
    });

    it('needs the turn in flight for the session’s own: a result after the turn’s `result` is dropped as a frame of no turn', () => {
      const played = inTurn();
      feed(played, ask('ask-1'));
      const placed = placeQuestion(played.state, { requestId: 'r-1', toolUseId: 'ask-1', agentId: null }) as PlacedQuestion;
      questionAnswered(played.state, placed, 'ask-1');
      feed(played, { type: 'result', is_error: false });
      feed(played, answered('ask-1'));
      expect(resolved(played)).toEqual([]);
      expect(played.drops).toEqual(['other-turn']);
    });
  });

  describe('a worker’s (C21, C72)', () => {
    it('opens no activity for a worker’s question tool use, and keeps the question under the worker', () => {
      const played = withWorker();
      const before = played.events.length;
      feed(played, ask('w-ask-1', 'agent-1'));
      // Its first frame names the worker's model (M106, C14), and nothing more: the question opens no activity.
      expect(played.events.slice(before).map((event) => event.type)).toEqual(['worker-model', 'activity-started']);
      expect(played.state.workers.get('task-1')?.questions).toEqual(new Map([['w-ask-1', { requestId: null, answered: false, declined: false }]]));
      expect(played.state.workers.get('task-1')?.tools.size).toBe(0);
      expect(played.state.turn?.questions.size).toBe(0);
      // A tool beside it is the worker's activity, as before.
      feed(played, assistant([use('w-tool-1', 'Read', { file_path: 'notes-1.txt' })], 'agent-1'));
      expect(starts(played).at(-1)).toMatchObject({ itemId: 'w-tool-1', workerId: 'task-1', activityType: 'read' });
      valid(played);
    });

    it.each([
      ['before the parent’s `result`', false, false],
      ['after the parent’s `result`', true, false],
      ['after it, with the error flag', true, true],
      ['before it, with the error flag', false, true],
    ] as const)('marks a worker’s answer confirmed by the worker’s own result, %s', (_when, afterResult, isError) => {
      const played = withWorker();
      feed(played, ask('w-ask-1', 'agent-1'));
      const placed = placeQuestion(played.state, { requestId: 'r-w1', toolUseId: 'w-ask-1', agentId: 'task-1' }) as PlacedQuestion;
      expect(placed).toEqual({ turnId: RUNTIME(1), workerId: 'task-1' });
      // The parent's turn completes while the worker runs: no turn is in flight when the result comes.
      if (afterResult) feed(played, { type: 'result', is_error: false });
      questionAnswered(played.state, placed, 'w-ask-1');
      const before = played.events.length;
      feed(played, answered('w-ask-1', 'agent-1', isError));
      expect(played.events.slice(before)).toEqual([{ type: 'question-resolved', requestId: 'r-w1', reason: 'confirmed' }]);
      expect(closed(played)).toEqual([{ type: 'question-closed', requestId: 'r-w1', failed: isError }]);
      expect(played.drops).toEqual([]);
      expect(played.state.workers.get('task-1')?.questions.size).toBe(0);
      // It ended no activity of the worker's, and failed none.
      expect(ends(played)).toEqual([]);
      valid(played);
    });

    it('reads a worker’s result by the worker’s path alone: one that names no parent is no worker’s, and confirms nothing of it', () => {
      const played = withWorker();
      feed(played, ask('w-ask-1', 'agent-1'));
      const placed = placeQuestion(played.state, { requestId: 'r-w1', toolUseId: 'w-ask-1', agentId: 'task-1' }) as PlacedQuestion;
      questionAnswered(played.state, placed, 'w-ask-1');
      feed(played, answered('w-ask-1'));
      expect(resolved(played)).toEqual([]);
      expect(played.drops).toEqual(['unopened-item']);
      feed(played, answered('w-ask-1', 'agent-1'));
      expect(resolved(played)).toEqual([{ type: 'question-resolved', requestId: 'r-w1', reason: 'confirmed' }]);
    });

    it('lets a worker’s questions go with the worker: its end, by its frames or by a Stop, leaves nothing to confirm', () => {
      for (const how of ['notified', 'failed'] as const) {
        const played = withWorker();
        feed(played, ask('w-ask-1', 'agent-1'));
        const placed = placeQuestion(played.state, { requestId: 'r-w1', toolUseId: 'w-ask-1', agentId: 'task-1' }) as PlacedQuestion;
        questionAnswered(played.state, placed, 'w-ask-1');
        if (how === 'notified') feed(played, task('task_notification', 'task-1', { tool_use_id: 'agent-1', status: 'completed', summary: 'Done.' }));
        else failChatWorkers(played.state);
        const before = played.events.length;
        feed(played, answered('w-ask-1', 'agent-1'));
        expect(played.events.slice(before), how).toEqual([]);
        expect(resolved(played), how).toEqual([]);
        // What became of the request is the session's to say: these change nothing of a worker that is gone.
        questionAnswered(played.state, placed, 'w-ask-1');
        questionReleased(played.state, placed, 'w-ask-1');
        expect(placeQuestion(played.state, { requestId: 'r-w2', toolUseId: 'w-ask-2', agentId: 'task-1' }), how).toBeNull();
      }
    });
  });
});

// M22 (V2, V34; C5, C7, C97): each `init` is held to the mode the process runs under — its word, and its tools.
describe('the mode an `init` is held to (M22: V2, V34)', () => {
  const under = (id: keyof typeof CLAUDE_MODES): ChatMapperState => newChatMapper(FOLDER, false, CLAUDE_MODES[id]);
  const overruled = (played: Played): number => played.effects.filter((effect) => effect.type === 'overruled').length;

  it('passes K2’s and K5’s turns under the mode each ran under, and finds each under every mode of another word or a shorter tool list', () => {
    const ran: [string, keyof typeof CLAUDE_MODES][] = [['m22-approve-once', 'ask-first'], ['m22-approve-files', 'ask-first'], ['m22-mode-worker', 'edits-ok'], ['m22-mode-auto', 'auto-reviewed'], ['m22-mode-bypass-main', 'berserk']];
    for (const [name, id] of ran) {
      expect(overruled(play(name, { state: under(id) })), `${name} under ${id}`).toBe(0);
      for (const other of Object.keys(CLAUDE_MODES) as (keyof typeof CLAUDE_MODES)[]) if (other !== id) expect(overruled(play(name, { state: under(other) })), `${name} under ${other}`).toBeGreaterThan(0);
    }
    // A turn of the launch before there were modes passes under the reading mode, and under Ask first too: its tools are among the eight.
    expect([overruled(play('m21-question-one')), overruled(play('m21-question-one', { state: under('ask-first') }))]).toEqual([0, 0]);
  });

  it('takes the tools a mode that acts is launched with, or fewer, and no other, and under the reading mode none of those that act or reach the web', () => {
    const withTools = (id: keyof typeof CLAUDE_MODES, tools: unknown) => play('m22-approve-once', { state: under(id), change: (frame) => (isInit(frame) ? { ...frame, tools } : frame), until: 5 }).effects.map((effect) => effect.type);
    const eight = ['Task', 'AskUserQuestion', 'Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write'];
    expect(withTools('ask-first', [...eight, 'mcp__notes__write'])).toEqual(['started']);
    expect(withTools('ask-first', ['Task', 'AskUserQuestion', 'Bash', 'Edit', 'ExitPlanMode', 'Glob', 'Grep', 'Read', 'WebFetch', 'WebSearch', 'Write'])).toEqual(['started']);
    for (const other of ['ToolSearch', 'NotebookEdit', 'MultiEdit', 'Skill', 'bash', 'websearch']) expect(withTools('ask-first', [...eight, other]), other).toEqual(['started', 'overruled']);
    for (const tool of ['Bash', 'Write', 'Edit', 'WebFetch', 'WebSearch']) expect(withTools('read-only', ['Task', 'Read', tool]), tool).toEqual(['started', 'overruled']);
  });

  it('follows a change the session confirmed between two turns: K2’s turn under Edits ok, then its next under Ask first again', () => {
    const state = under('ask-first');
    const played = blank(state);
    let turn = 0;
    for (const { dir, frame } of load('m22-mode-accept-edits')) {
      if (dir === 'send') {
        if (frame['type'] === 'user' && typeof frame['uuid'] === 'string') beginChatTurn(state, RUNTIME(++turn), frame['uuid']);
        // What the session does at a change's confirmed reply: the mode in force is the mapper's to hold the next `init` to.
        if (at(frame, 'request', 'subtype') === 'set_permission_mode') state.mode = at(frame, 'request', 'mode') === 'acceptEdits' ? CLAUDE_MODES['edits-ok'] : CLAUDE_MODES['ask-first'];
        if (at(frame, 'request', 'subtype') === 'interrupt' && state.turn !== null) state.turn.stopped = true;
        continue;
      }
      if (frame['type'] !== 'control_response') feed(played, frame);
    }
    expect(overruled(played)).toBe(0);
    expect(played.ends().map((end) => end.outcome)).toEqual(['completed', 'interrupted']);
    // Held to the mode it had before the change, the first turn's `init` is another policy's.
    expect(overruled(play('m22-mode-accept-edits', { state: under('ask-first'), until: 8 }))).toBe(1);
  });

  it('shows a worker’s actions under Edits ok with no request at all, as K5 saw them: its file change and its command, each the worker’s own activity (C97)', () => {
    expect(load('m22-mode-worker').filter((entry) => entry.dir === 'recv' && entry.frame['type'] === 'control_request')).toEqual([]);
    const played = play('m22-mode-worker', { state: under('edits-ok') });
    valid(played);
    const worker = ofType(played, 'worker-started')[0]?.workerId;
    const work = starts(played).filter((event) => event.workerId === worker);
    expect(work.map((event) => [event.activityType, event.name])).toEqual([['edit', 'Write'], ['command', 'Bash']]);
    for (const started of work) expect(ends(played).find((event) => event.itemId === started.itemId), started.name).toMatchObject({ status: 'completed', workerId: worker });
    expect(played.events.some((event) => event.type === 'approval-resolved' || event.type === 'question-resolved')).toBe(false);
  });
});

// M22 (V21, V27; C11, C12, C76): the request the session placed, and the result of the tool use it asked leave for.
describe('a request to act (M22: V21)', () => {
  const state = (): ChatMapperState => newChatMapper(FOLDER, false, CLAUDE_MODES['ask-first']);
  const isAction = (frame: Json): boolean => frame['type'] === 'control_request' && at(frame, 'request', 'subtype') === 'can_use_tool';
  /** A capture as the session meets it: each request to act placed, and each reply fat-g sent told to the mapper as the decision it was. */
  function decided(name: string, mapper = state()): Played & { readonly placed: Map<string, PlacedRequest | null> } {
    const played = { ...blank(mapper), placed: new Map<string, PlacedRequest | null>() };
    const uses = new Map<string, string>();
    let turn = 0;
    for (const { dir, frame } of load(name)) {
      if (dir === 'recv' && isAction(frame)) {
        const requestId = String(frame['request_id']);
        const toolUseId = String(at(frame, 'request', 'tool_use_id'));
        uses.set(requestId, toolUseId);
        const agent = at(frame, 'request', 'agent_id');
        played.placed.set(requestId, placeApproval(mapper, { requestId, toolUseId, agentId: typeof agent === 'string' ? agent : null }));
        continue;
      }
      if (dir === 'send') {
        if (frame['type'] === 'user' && typeof frame['uuid'] === 'string') beginChatTurn(mapper, RUNTIME(++turn), frame['uuid']);
        const requestId = String(at(frame, 'response', 'request_id'));
        const placed = played.placed.get(requestId);
        if (frame['type'] === 'control_response' && placed != null) approvalDecided(mapper, placed, uses.get(requestId) ?? '', at(frame, 'response', 'response', 'behavior') === 'deny');
        continue;
      }
      if (frame['type'] !== 'control_response') feed(played, frame);
    }
    return played;
  }
  const resolved = (played: Played) => ofType(played, 'approval-resolved');
  const closed = (played: Played) => played.effects.flatMap((effect) => (effect.type === 'approval-closed' ? [effect.requestId] : []));
  /** A turn in flight, by frames of the CLI's own shape. */
  const flying = (mapper = state()): Played => {
    const played = blank(mapper);
    beginChatTurn(mapper, RUNTIME(1), 'prompt-1');
    feed(played, { type: 'command_lifecycle', command_uuid: 'prompt-1', state: 'started' });
    feed(played, { type: 'system', subtype: 'init', session_id: 's', model: 'claude-sonnet-5', tools: ['Task', 'Bash', 'Write', 'Edit', 'Read'], permissionMode: 'default' });
    return played;
  };
  const uses = (id = 'use-1', name = 'Bash', parent: string | null = null): Json => ({ type: 'assistant', uuid: `uuid-${id}`, parent_tool_use_id: parent, message: { model: 'claude-sonnet-5', content: [{ type: 'tool_use', id, name, input: { command: 'touch a.txt' } }] } });
  const results = (id = 'use-1', isError = false, parent: string | null = null, content = 'the result'): Json => ({ type: 'user', parent_tool_use_id: parent, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] } });
  const asked = (id = 'use-1', agentId: string | null = null) => ({ requestId: `request-${id}`, toolUseId: id, agentId });

  it('K2’s command, allowed and then denied: each result is the CLI’s word that it took the decision, and the denied command’s activity ends declined by the user, not failed', () => {
    const played = decided('m22-approve-once');
    valid(played);
    expect([...played.placed.values()]).toEqual([{ turnId: RUNTIME(1), workerId: null }, { turnId: RUNTIME(2), workerId: null }]);
    expect(resolved(played)).toEqual([{ type: 'approval-resolved', requestId: '<request-28>', reason: 'confirmed' }, { type: 'approval-resolved', requestId: '<request-64>', reason: 'confirmed' }]);
    expect(closed(played)).toEqual(['<request-28>', '<request-64>']);
    // The action's own activity stands beside its card: opened by its tool use, ended by the same result.
    expect(starts(played).filter((event) => event.activityType === 'command').map((event) => [event.itemId, event.activityType, event.summary])).toEqual([['<tool-use-16>', 'command', 'touch bash-once.txt'], ['<tool-use-54>', 'command', 'touch bash-once.txt']]);
    expect(ends(played).filter((event) => event.itemId.startsWith('<tool-use-'))).toEqual([
      // An allowed action keeps the status its provider gave (C76).
      { type: 'activity-ended', turnId: RUNTIME(1), itemId: '<tool-use-16>', status: 'completed', output: '(Bash completed with no output)' },
      { type: 'activity-ended', turnId: RUNTIME(2), itemId: '<tool-use-54>', status: 'declined', declinedBy: 'user', output: 'This action is not available in this session.' },
    ]);
    expect(played.drops).toEqual([]);
    expect(played.ends().map((end) => end.outcome)).toEqual(['completed', 'completed']);
  });

  it('K2’s four file changes, each allowed: four confirmations, each beside its own completed edit', () => {
    const played = decided('m22-approve-files');
    valid(played);
    expect(resolved(played).map((event) => event.reason)).toEqual(['confirmed', 'confirmed', 'confirmed', 'confirmed']);
    expect(starts(played).filter((event) => event.activityType === 'edit').map((event) => event.name)).toEqual(['Write', 'Edit', 'Write', 'Write']);
    expect(ends(played).filter((event) => starts(played).some((started) => started.itemId === event.itemId && started.activityType === 'edit')).map((event) => event.status)).toEqual(['completed', 'completed', 'completed', 'completed']);
  });

  it('K2’s worker: its request comes before the frame with its tool use, is placed under the worker all the same, and its result confirms it on the worker’s own path', () => {
    const frames = load('m22-approve-worker');
    const request = frames.findIndex((entry) => isAction(entry.frame));
    const use = frames.findIndex((entry) => entry.frame['type'] === 'assistant' && at(entry.frame, 'message', 'content', 0, 'id') === '<tool-use-41>');
    expect(request).toBeLessThan(use);
    const played = decided('m22-approve-worker');
    valid(played);
    expect([...played.placed.values()]).toEqual([{ turnId: RUNTIME(1), workerId: '<worker-34>' }]);
    expect(resolved(played)).toEqual([{ type: 'approval-resolved', requestId: String(frames[request]?.frame['request_id']), reason: 'confirmed' }]);
    expect(ends(played).find((event) => event.itemId === '<tool-use-41>')).toMatchObject({ status: 'completed', workerId: '<worker-34>', turnId: RUNTIME(1) });
  });

  it('keeps the provider’s status for an action that was allowed and then failed, and says declined only for one the user denied', () => {
    for (const [denied, isError, status] of [[false, false, 'completed'], [false, true, 'failed'], [true, true, 'declined'], [true, false, 'declined']] as const) {
      const played = flying();
      feed(played, uses());
      const placed = placeApproval(played.state, asked()) as PlacedRequest;
      approvalDecided(played.state, placed, 'use-1', denied);
      feed(played, results('use-1', isError));
      expect(resolved(played), status).toEqual([{ type: 'approval-resolved', requestId: 'request-use-1', reason: 'confirmed' }]);
      expect(ends(played), status).toEqual([{ type: 'activity-ended', turnId: RUNTIME(1), itemId: 'use-1', status, ...(denied ? { declinedBy: 'user' } : {}), output: 'the result' }]);
    }
  });

  it('says nothing of a request the CLI took back or fat-g refused, and of one nobody decided only that it is over: the activity ends as its result reads', () => {
    const released = flying();
    feed(released, uses());
    approvalReleased(released.state, placeApproval(released.state, asked()) as PlacedRequest, 'use-1');
    feed(released, results('use-1', true));
    expect([resolved(released), closed(released)]).toEqual([[], []]);
    expect(ends(released)).toMatchObject([{ itemId: 'use-1', status: 'failed' }]);
    // Decided after it was let go: nothing is decided.
    const late = flying();
    feed(late, uses());
    const placed = placeApproval(late.state, asked()) as PlacedRequest;
    approvalReleased(late.state, placed, 'use-1');
    approvalDecided(late.state, placed, 'use-1', true);
    feed(late, results('use-1', true));
    expect(ends(late)).toMatchObject([{ status: 'failed' }]);
    // With no decision the session is told the request is over, and no confirmation is said.
    const undecided = flying();
    feed(undecided, uses());
    placeApproval(undecided.state, asked());
    feed(undecided, results('use-1', true));
    expect([resolved(undecided), closed(undecided)]).toEqual([[], ['request-use-1']]);
    expect(ends(undecided)).toMatchObject([{ status: 'failed' }]);
  });

  it('places a request by the rule a question is placed by, and a second one for a tool use that has one nowhere (C11)', () => {
    const played = flying();
    expect(placeApproval(played.state, asked())).toEqual({ turnId: RUNTIME(1), workerId: null });
    expect(placeApproval(played.state, { ...asked(), requestId: 'another' })).toBeNull();
    // An open, paired worker's is the worker's; one that names a worker that ended is nobody's.
    feed(played, uses('agent-1', 'Agent'));
    feed(played, { type: 'system', subtype: 'task_started', task_id: 'task-1', tool_use_id: 'agent-1', description: 'Works' });
    expect(placeApproval(played.state, asked('use-w', 'task-1'))).toEqual({ turnId: RUNTIME(1), workerId: 'task-1' });
    feed(played, { type: 'system', subtype: 'task_notification', task_id: 'task-1', tool_use_id: 'agent-1', status: 'completed', summary: 'done' });
    expect(placeApproval(played.state, asked('use-w2', 'task-1'))).toBeNull();
    // With no turn in flight the session's own has no owner.
    expect(placeApproval(state(), asked())).toBeNull();
    feed(played, { type: 'result', subtype: 'success', is_error: false });
    expect(placeApproval(played.state, asked('use-late'))).toBeNull();
  });

  it('confirms a worker’s after its parent turn’s `result`, by the worker’s own path, and ends its activity under the worker', () => {
    const played = flying();
    feed(played, uses('agent-1', 'Agent'));
    feed(played, { type: 'system', subtype: 'task_started', task_id: 'task-1', tool_use_id: 'agent-1', description: 'Works' });
    const placed = placeApproval(played.state, asked('use-w', 'task-1')) as PlacedRequest;
    feed(played, uses('use-w', 'Bash', 'agent-1'));
    feed(played, { type: 'result', subtype: 'success', is_error: false });
    approvalDecided(played.state, placed, 'use-w', true);
    feed(played, results('use-w', true, 'agent-1'));
    expect(resolved(played)).toEqual([{ type: 'approval-resolved', requestId: 'request-use-w', reason: 'confirmed' }]);
    expect(ends(played).find((event) => event.itemId === 'use-w')).toEqual({ type: 'activity-ended', turnId: RUNTIME(1), itemId: 'use-w', workerId: 'task-1', status: 'declined', declinedBy: 'user', output: 'the result' });
  });
});

// M22 (V21; C76): a rule of the user's own configuration refuses a tool's use, and no request is made.
describe('a denial by a rule (M22: V21)', () => {
  const state = (): ChatMapperState => newChatMapper(FOLDER, false, CLAUDE_MODES['ask-first']);
  const denial = (toolUseId: unknown = 'use-1', reason: unknown = 'rule'): Json => ({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: toolUseId, decision_reason_type: reason, message: 'Permission to use Bash with command touch private.txt has been denied.' });
  const uses = (id = 'use-1', parent: string | null = null): Json => ({ type: 'assistant', uuid: `uuid-${id}`, parent_tool_use_id: parent, message: { model: 'claude-sonnet-5', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'touch private.txt' } }] } });
  const results = (id = 'use-1', parent: string | null = null): Json => ({ type: 'user', parent_tool_use_id: parent, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'Permission to use Bash with command touch private.txt has been denied.', is_error: true }] } });
  const flying = (): Played => {
    const played = blank(state());
    beginChatTurn(played.state, RUNTIME(1), 'prompt-1');
    feed(played, { type: 'command_lifecycle', command_uuid: 'prompt-1', state: 'started' });
    feed(played, { type: 'system', subtype: 'init', session_id: 's', tools: ['Task', 'Bash', 'Read'], permissionMode: 'default' });
    return played;
  };

  it('K2’s turn: the command a rule allowed ran with no request and is completed; the one a rule denied ends declined by a rule at its frame, and the error result after it is passed over', () => {
    expect(load('m22-inherited').filter((entry) => entry.dir === 'recv' && entry.frame['type'] === 'control_request')).toEqual([]);
    const played = play('m22-inherited', { state: state() });
    valid(played);
    const commands = starts(played).filter((event) => event.activityType === 'command');
    expect(commands.map((event) => event.itemId)).toEqual(['<tool-use-15>', '<tool-use-33>']);
    expect(ends(played).filter((event) => commands.some((command) => command.itemId === event.itemId))).toEqual([
      { type: 'activity-ended', turnId: RUNTIME(1), itemId: '<tool-use-15>', status: 'completed', output: '(Bash completed with no output)' },
      // No output: the frame's message is not read, and the result that repeats it ends nothing twice.
      { type: 'activity-ended', turnId: RUNTIME(1), itemId: '<tool-use-33>', status: 'declined', declinedBy: 'rule' },
    ]);
    // The result that follows the denial is no result of an unopened item, and is not counted as one.
    expect(played.drops).toEqual([]);
    expect(played.ends().map((end) => end.outcome)).toEqual(['completed']);
  });

  it('says no cause for a denial whose reason is no rule, and ends the activity declined all the same', () => {
    const played = flying();
    feed(played, uses());
    feed(played, denial('use-1', 'classifier'));
    feed(played, results());
    expect(ends(played)).toEqual([{ type: 'activity-ended', turnId: RUNTIME(1), itemId: 'use-1', status: 'declined' }]);
    expect(played.drops).toEqual([]);
  });

  it('keeps a denial that comes before its tool use is known, and ends that use declined at its result, with the result’s words', () => {
    const played = flying();
    feed(played, denial());
    expect(played.events.filter((event) => event.type === 'activity-ended')).toEqual([]);
    feed(played, uses());
    feed(played, results());
    expect(ends(played)).toEqual([{ type: 'activity-ended', turnId: RUNTIME(1), itemId: 'use-1', status: 'declined', declinedBy: 'rule', output: 'Permission to use Bash with command touch private.txt has been denied.' }]);
    expect(played.drops).toEqual([]);
  });

  it('ends a worker’s tool use under the worker, and drops a frame that names no tool use', () => {
    const played = flying();
    feed(played, { type: 'assistant', uuid: 'uuid-agent', parent_tool_use_id: null, message: { model: 'claude-sonnet-5', content: [{ type: 'tool_use', id: 'agent-1', name: 'Agent', input: { description: 'Works' } }] } });
    feed(played, { type: 'system', subtype: 'task_started', task_id: 'task-1', tool_use_id: 'agent-1', description: 'Works' });
    feed(played, uses('use-w', 'agent-1'));
    feed(played, denial('use-w'));
    feed(played, results('use-w', 'agent-1'));
    expect(ends(played).filter((event) => event.itemId === 'use-w')).toEqual([{ type: 'activity-ended', turnId: RUNTIME(1), itemId: 'use-w', workerId: 'task-1', status: 'declined', declinedBy: 'rule' }]);
    expect(played.drops).toEqual([]);
    feed(played, denial(7));
    expect(played.drops).toEqual(['invalid']);
  });
});

// ── M106: the model a sub-agent runs on ───────────────────────────────────────────────────────
// V3 (docs/planning/_archive/M106.md, Design 2; C14, C20, C38): K1's two captures — two workers in the
// background on `haiku` and `opus` under a `claude-sonnet-5` session, each reading a file, and one in
// the foreground on `haiku` that used no tool — and frames made here for what K1 did not show.
describe('the model a sub-agent runs on (M106: V3)', () => {
  const background = play('m106-claude-background');
  const foreground = play('m106-claude-foreground');
  const HAIKU = { worker: '<worker-10>', launch: '<tool-use-7>', resolved: 'claude-haiku-4-5-20251001' };
  const OPUS = { worker: '<worker-17>', launch: '<tool-use-15>', resolved: 'claude-opus-5' };

  it('starts each worker with the alias its `Agent` tool use asked for and the agent definition `task_started` names', () => {
    expect(ofType(background, 'worker-started')).toEqual([
      { type: 'worker-started', workerId: HAIKU.worker, description: 'Read README and reply code', model: 'haiku', agentType: 'general-purpose' },
      { type: 'worker-started', workerId: OPUS.worker, description: 'Read README and reply code', model: 'opus', agentType: 'general-purpose' },
    ]);
    // The pairing start of each worker item carries both, for the conversation store.
    for (const { worker, launch } of [HAIKU, OPUS]) {
      expect(starts(background).find((event) => event.itemId === launch && event.pairedWorkerId === worker && event.model !== undefined), launch).toMatchObject({ activityType: 'worker', model: launch === HAIKU.launch ? 'haiku' : 'opus', agentType: 'general-purpose' });
    }
    valid(background);
    // The turns the CLI ran by itself to report on its workers are none of fat-g's (C31): nothing else is dropped.
    expect(new Set(background.drops)).toEqual(new Set(['other-turn']));
  });

  it('names each worker’s resolved id once, at its first frame, for the list and for its item, before the frame’s own events', () => {
    expect(ofType(background, 'worker-model')).toEqual([
      { type: 'worker-model', workerId: HAIKU.worker, model: HAIKU.resolved },
      { type: 'worker-model', workerId: OPUS.worker, model: OPUS.resolved },
    ]);
    for (const { worker, launch, resolved } of [HAIKU, OPUS]) {
      const named = background.events.findIndex((event) => event.type === 'worker-model' && event.workerId === worker);
      // A second start of its item, which keeps its name and line and says the id: the next event.
      expect(background.events[named + 1]).toEqual({ type: 'activity-started', turnId: RUNTIME(1), itemId: launch, activityType: 'worker', name: 'Agent', summary: 'Read README and reply code', pairedWorkerId: worker, model: resolved });
      // Before anything else its frames said.
      const first = background.events.findIndex((event) => event.type !== 'worker-model' && event.type !== 'worker-progressed' && 'workerId' in event && event.workerId === worker && event.type !== 'worker-started');
      expect(first, worker).toBeGreaterThan(named);
    }
  });

  it('leaves the foreground worker, which sent no frame of its own, with the alias alone', () => {
    expect(ofType(foreground, 'worker-started')).toEqual([{ type: 'worker-started', workerId: '<worker-11>', description: 'Reply with exact word', model: 'haiku', agentType: 'general-purpose' }]);
    expect(ofType(foreground, 'worker-model')).toEqual([]);
    valid(foreground);
  });

  it('names no model where the tool use asks for none that is a key, and loses no worker for it', () => {
    for (const model of ['', 'two words', 42, 'x'.repeat(129), null]) {
      const played = play('m106-claude-foreground', { change: (frame) => (frame['type'] === 'assistant' && frame['parent_tool_use_id'] === null ? { ...frame, message: { ...(frame['message'] as Json), content: ((frame['message'] as Json)['content'] as Json[]).map((block) => (block['type'] === 'tool_use' ? { ...block, input: { ...(block['input'] as Json), model } } : block)) } } : frame) });
      expect(ofType(played, 'worker-started'), String(model)).toEqual([{ type: 'worker-started', workerId: '<worker-11>', description: 'Reply with exact word', agentType: 'general-purpose' }]);
      valid(played);
    }
  });

  it('takes no model from the CLI’s own marker, nor one that is no key, and names a later change once more', () => {
    const state = newChatMapper(FOLDER, true);
    beginChatTurn(state, RUNTIME(1), 'prompt-1');
    const made = blank(state);
    feed(made, { type: 'command_lifecycle', command_uuid: 'prompt-1', state: 'started' });
    let uuid = 0;
    const said = (model: unknown): Json => ({ type: 'assistant', uuid: `m-${++uuid}`, parent_tool_use_id: 'agent-1', message: { id: `r-${uuid}`, model, content: [{ type: 'text', text: 'Working.' }] } });
    feed(made, { type: 'assistant', uuid: 'own-1', parent_tool_use_id: null, message: { id: 'r-0', model: 'claude-sonnet-5', content: [{ type: 'tool_use', id: 'agent-1', name: 'Agent', input: { description: 'Reads notes', subagent_type: 'Explore' } }] } });
    feed(made, { type: 'system', subtype: 'task_started', task_id: 'task-1', tool_use_id: 'agent-1', description: 'Reads notes' });
    // No `subagent_type` on `task_started`: the tool use's own stands.
    expect(ofType(made, 'worker-started')).toEqual([{ type: 'worker-started', workerId: 'task-1', description: 'Reads notes', agentType: 'Explore' }]);
    for (const model of ['<synthetic>', 'two words', '']) feed(made, said(model));
    expect(ofType(made, 'worker-model')).toEqual([]);
    feed(made, said('claude-sonnet-5'));
    feed(made, said('claude-sonnet-5'));
    feed(made, said('claude-opus-5'));
    expect(ofType(made, 'worker-model').map((event) => event.model)).toEqual(['claude-sonnet-5', 'claude-opus-5']);
    valid(made);
  });
});
