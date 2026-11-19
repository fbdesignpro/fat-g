// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V2, V13, V35, V46, V59 (docs/planning/_archive/M15.md; C10, C37–C44, C101, C113, C133) and V3 (M20a.md; C7,
// C9–C12, C14, C20, C21, C23, C24): the frame mapping,
// table-driven per capture. Each capture's received frames go through the mapper as the session
// feeds them: those that came before the `turn/start` reply named the turn are held and mapped once
// it has.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type AgentEvent, AgentEventSchema, MAX_MESSAGE_TEXT, MAX_QUESTION_TEXT } from '@shared/contracts/agent-events';
import { MAX_LINE_INPUT } from '@shared/contracts/sessions';
import { expireWorker, failWorkers, mapFrame, MAPPED_METHODS, type MappedMethod, type MapperEffect, type MapperState, newTurn, newWorker, REVIEW_METHODS } from './turn-mapper';

interface Frame { readonly index: number; readonly dir: 'send' | 'recv'; readonly frame: Record<string, unknown> }
interface Capture { readonly frames: Frame[]; readonly sessionStart: { readonly replyIndex: number } }
const load = (name: string): Capture => JSON.parse(readFileSync(path.resolve('tests/fixtures/codex/captures', `${name}.json`), 'utf8')) as Capture;
const at = (value: unknown, ...keys: (string | number)[]): unknown => keys.reduce<unknown>((current, key) => (current !== null && typeof current === 'object' ? (current as Record<string | number, unknown>)[key] : undefined), value);
const isMapped = (method: unknown): method is MappedMethod => (MAPPED_METHODS as readonly unknown[]).includes(method);
const RUNTIME = 'runtime-turn-1';

interface Played { readonly events: AgentEvent[]; readonly drops: string[]; readonly effects: MapperEffect[]; readonly unmapped: string[]; readonly state: MapperState }

/** A capture's frames from its `turn/start` on, through the mapper. `change` edits or withholds a frame first. */
function play(name: string, change: (frame: Record<string, unknown>) => Record<string, unknown> | null = (frame) => frame, reorder: (frames: Frame[]) => Frame[] = (frames) => frames): Played {
  const capture = load(name);
  const session = String(at(capture.frames.find((f) => f.index === capture.sessionStart.replyIndex)?.frame, 'result', 'thread', 'id'));
  const start = capture.frames.find((f) => f.dir === 'send' && f.frame['method'] === 'turn/start') as Frame;
  const state: MapperState = { threadId: session, turn: null, workers: new Map(), asides: new Map(), denied: new Set() };
  const out: Played = { events: [], drops: [], effects: [], unmapped: [], state };
  const held: Record<string, unknown>[] = [];
  const map = (frame: Record<string, unknown>): void => {
    const mapped = mapFrame(state, frame['method'] as MappedMethod, frame['params']);
    out.events.push(...mapped.events);
    out.effects.push(...mapped.effects);
    if (mapped.drop !== null) out.drops.push(mapped.drop);
  };
  for (const entry of reorder(capture.frames.filter((f) => f.dir === 'recv' && f.index > start.index))) {
    const frame = change(entry.frame);
    if (frame === null) continue;
    if (frame['method'] === undefined) {
      if (frame['id'] !== start.frame['id']) continue;
      state.turn = newTurn(RUNTIME, String(at(frame, 'result', 'turn', 'id')));
      for (const waiting of held.splice(0)) map(waiting);
      continue;
    }
    if (!isMapped(frame['method'])) { out.unmapped.push(typeof frame['method'] === 'string' ? frame['method'] : '?'); continue; }
    if (state.turn === null) held.push(frame); else map(frame);
  }
  return out;
}

const types = (played: Played): string[] => played.events.map((event) => event.type);
/** The session's own messages: a worker's name their worker (M20a, C20). */
const messages = (played: Played) => played.events.flatMap((event) => (event.type === 'message' && event.workerId === undefined ? [event] : []));
const actions = (played: Played) => played.events.filter((event) => event.type === 'action-changed');
const starts = (played: Played) => played.events.flatMap((event) => (event.type === 'activity-started' ? [event] : []));
const ends = (played: Played) => played.events.flatMap((event) => (event.type === 'activity-ended' ? [event] : []));

describe('T1, a basic turn (V13)', () => {
  const played = play('t1-basic');
  /** The commentary as the capture holds it, whole; and its first line, which is the label. */
  const commentary = String(at(load('t1-basic').frames.find((f) => f.frame['method'] === 'item/completed' && at(f.frame, 'params', 'item', 'phase') === 'commentary')?.frame, 'params', 'item', 'text'));
  const firstLine = commentary.split('\n')[0] as string;

  it('emits only events that pass the schema, each naming the runtime’s turn', () => {
    for (const event of played.events) expect(AgentEventSchema.safeParse(event).success, event.type).toBe(true);
    expect(played.events.every((event) => !('turnId' in event) || event.turnId === RUNTIME)).toBe(true);
    expect(played.drops).toEqual([]);
  });

  it('maps the echo, the commentary and the answer as messages, in order', () => {
    expect(messages(played).map((event) => [event.role, event.phase])).toEqual([['user', null], ['assistant', 'commentary'], ['assistant', 'final']]);
    expect(commentary).toContain('read sample.txt');
    expect(messages(played)[1]?.text).toBe(commentary);
    expect(messages(played)[2]?.text).toContain('Biscuit');
  });

  it('gives the reading action the file’s name, and the commentary as its line; a command line is never sent', () => {
    const reading = actions(played).find((event) => event.kind === 'reading');
    expect(reading).toEqual({ type: 'action-changed', turnId: RUNTIME, kind: 'reading', line: firstLine, file: 'sample.txt' });
    expect(actions(played).map((event) => event.kind)).toEqual(['writing', 'thinking', 'reading', 'thinking', 'writing', 'thinking']);
    // To the summary, never: an action's label holds no command line, as before.
    expect(JSON.stringify(actions(played))).not.toMatch(/Get-Content|powershell|pwsh/i);
    // To the chat, as the read's input (M20a, C14, C30): conversation content, in the store alone.
    expect(starts(played)).toMatchObject([{ activityType: 'read', summary: 'sample.txt', input: expect.stringContaining('Get-Content') as string }]);
  });

  it('says that the turn started, then that it ended completed, and nothing ends it twice', () => {
    expect(played.effects.filter((effect) => effect.type === 'turn-started')).toHaveLength(1);
    expect(played.effects.filter((effect) => effect.type === 'turn-ended')).toEqual([{ type: 'turn-ended', status: 'completed', detail: null }]);
    expect(played.state.turn?.ended).toBe(true);
  });

  it('never parses the methods it does not map', () => {
    expect(new Set(played.unmapped)).toEqual(new Set(['thread/tokenUsage/updated', 'account/rateLimits/updated']));
  });
});

describe('T3, a worker (V13)', () => {
  const played = play('t3-subagent');

  it('opens the worker and closes it once, as completed', () => {
    expect(types(played).filter((type) => type.startsWith('worker'))).toEqual(expect.arrayContaining(['worker-started', 'worker-progressed', 'worker-ended']));
    expect(played.events.filter((event) => event.type === 'worker-started')).toHaveLength(1);
    expect(played.events.filter((event) => event.type === 'worker-ended')).toEqual([expect.objectContaining({ outcome: 'completed' })]);
    expect(played.state.workers.size).toBe(0);
  });

  it('keeps the worker’s own message the worker’s, and its path out of everything (M20a, C20, C21)', () => {
    const texts = messages(played).map((event) => event.text);
    expect(texts.some((text) => text.includes('logbook'))).toBe(true);
    // The session's own answer quotes it; the worker's own report, a message of its thread, names its worker.
    const [workerId] = played.events.flatMap((event) => (event.type === 'worker-started' ? [event.workerId] : []));
    const workers = played.events.filter((event) => event.type === 'message' && event.workerId !== undefined);
    expect(workers).not.toHaveLength(0);
    expect(workers.every((event) => event.type === 'message' && event.workerId === workerId && event.role === 'assistant')).toBe(true);
    expect(JSON.stringify(played.events)).not.toMatch(/agentPath|\/root\//);
  });

  it('drops and counts the worker’s frame that arrives before its announcement', () => {
    expect(played.drops).toEqual(['other-thread']);
  });

  it('shows the session waiting while the worker runs', () => {
    expect(actions(played).map((event) => event.kind)).toContain('waiting');
  });
});

describe('T4, T5 and T6 (V13)', () => {
  it('T4 ends interrupted, and its late item ends the activity it names and changes nothing else (M20a, C6)', () => {
    const played = play('t4-interrupt');
    expect(played.effects.filter((effect) => effect.type === 'turn-ended')).toEqual([{ type: 'turn-ended', status: 'interrupted', detail: null }]);
    const end = played.effects.findIndex((effect) => effect.type === 'turn-ended');
    expect(end).toBeGreaterThan(-1);
    expect(played.drops).toEqual([]);
    // The command's completion came after the turn's end: it still ends its item, and is the last word.
    expect(types(played).at(-1)).toBe('activity-ended');
    expect(ends(played)).toHaveLength(1);
    expect(ends(played)[0]?.itemId).toBe(starts(played)[0]?.itemId);
    // No action and no message came of it: the summary's last word is as it was.
    expect(types(played).filter((type) => type !== 'activity-ended').at(-1)).toBe('action-changed');
    expect(actions(played).at(-1)?.kind).toBe('reading');
    expect(played.state.turn?.activities.size).toBe(0);
  });

  it('lets nothing else of an ended turn through: a late start opens no activity, and a second completion ends none', () => {
    const played = play('t4-interrupt');
    const { state } = played;
    const late = { threadId: state.threadId, turnId: state.turn?.cliId, item: { type: 'commandExecution', id: 'late-item', command: 'x', commandActions: [] } };
    expect(mapFrame(state, 'item/started', late)).toEqual({ events: [], effects: [], drop: null });
    expect(mapFrame(state, 'item/completed', late)).toEqual({ events: [], effects: [], drop: null });
    expect(mapFrame(state, 'turn/plan/updated', { threadId: state.threadId, turnId: state.turn?.cliId, plan: [{ step: 'late', status: 'pending' }] }).drop).toBe('other-turn');
  });

  it('T5 fails with the API’s inner message as its detail', () => {
    const played = play('t5-error');
    expect(played.effects.filter((effect) => effect.type === 'turn-ended')).toEqual([{ type: 'turn-ended', status: 'failed', detail: "The 'm10-no-such-model' model is not supported when using Codex with a ChatGPT account." }]);
  });

  it('an error the CLI will retry ends nothing and leaves no detail', () => {
    const played = play('t5-error', (frame) => {
      if (frame['method'] === 'turn/completed') return null;
      if (frame['method'] === 'error') return { ...frame, params: { ...(frame['params'] as object), willRetry: true } };
      return frame;
    });
    expect(played.effects.some((effect) => effect.type === 'turn-ended')).toBe(false);
    expect(played.state.turn?.detail).toBeNull();
    expect(played.state.turn?.ended).toBe(false);
  });

  it('T6 carries its questions in its message', () => {
    const played = play('t6-question');
    const asked = messages(played).filter((event) => event.questions !== undefined);
    expect(asked[0]?.questions).toEqual([{ title: 'Should I read notes-1.txt or notes-2.txt?', options: ['notes-1.txt', 'notes-2.txt'] }]);
    expect(actions(played).map((event) => event.kind)).toEqual(expect.arrayContaining(['thinking', 'waiting']));
    expect(played.effects.at(-1)).toEqual({ type: 'turn-ended', status: 'completed', detail: null });
  });
});

describe('whose frame, whose turn (C11, C37)', () => {
  it('drops a frame of another turn of the session’s thread, counted', () => {
    const played = play('t1-basic', (frame) => (frame['method'] === 'item/completed' && at(frame, 'params', 'item', 'phase') === 'commentary' ? { ...frame, params: { ...(frame['params'] as object), turnId: 'another-turn' } } : frame));
    expect(played.drops).toEqual(['other-turn']);
    expect(messages(played).map((event) => event.phase)).toEqual([null, 'final']);
  });

  it('drops a frame whose ids are not ids, counted', () => {
    const played = play('t1-basic', (frame) => (frame['method'] === 'item/completed' && at(frame, 'params', 'item', 'phase') === 'final_answer' ? { ...frame, params: { ...(frame['params'] as object), item: { ...(at(frame, 'params', 'item') as object), id: 'x'.repeat(300) } } } : frame));
    expect(played.drops).toEqual(['invalid']);
    expect(messages(played).map((event) => event.phase)).toEqual([null, 'commentary']);
  });
});

describe('a worker’s end, settled in either order (V35, V59; C101, C133)', () => {
  const isClosing = (frame: Record<string, unknown>): boolean => at(frame, 'params', 'item', 'type') === 'subAgentActivity' && at(frame, 'params', 'item', 'kind') === 'completed';
  const session = String(at(load('t3-subagent').frames.find((f) => f.index === load('t3-subagent').sessionStart.replyIndex)?.frame, 'result', 'thread', 'id'));
  const isWorkerEnd = (frame: Record<string, unknown>): boolean => frame['method'] === 'turn/completed' && at(frame, 'params', 'threadId') !== session;
  const ends = (played: Played) => played.events.filter((event) => event.type === 'worker-ended');
  /** A worker's end as the mapper tells it (M20a, C23): the item that announced it first, then the list. */
  const ended = (played: Played, workerId: unknown, outcome: 'completed' | 'failed') => [{ type: 'activity-ended', turnId: RUNTIME, itemId: played.events.flatMap((event) => (event.type === 'activity-started' && event.activityType === 'worker' ? [event.itemId] : []))[0], status: outcome }, { type: 'worker-ended', workerId, outcome }];
  const fail = (frame: Record<string, unknown>): Record<string, unknown> => (isWorkerEnd(frame) ? { ...frame, params: { ...(frame['params'] as object), turn: { ...(at(frame, 'params', 'turn') as object), status: 'failed' } } } : frame);

  /** The three traced orders: the closing item's two frames before, around, and after the worker's own end. */
  const orders: Record<string, (frames: Frame[]) => Frame[]> = {
    'closing item first': (frames) => frames,
    'around the turn’s end': (frames) => {
      const end = frames.findIndex((f) => isWorkerEnd(f.frame));
      const firstClosing = frames.findIndex((f) => isClosing(f.frame));
      const moved = [...frames];
      const [frame] = moved.splice(end, 1);
      moved.splice(firstClosing + 1, 0, frame as Frame);
      return moved;
    },
    'turn’s end first': (frames) => {
      const end = frames.findIndex((f) => isWorkerEnd(f.frame));
      const firstClosing = frames.findIndex((f) => isClosing(f.frame));
      const moved = [...frames];
      const [frame] = moved.splice(end, 1);
      moved.splice(firstClosing, 0, frame as Frame);
      return moved;
    },
  };

  it.each(Object.keys(orders))('%s: the worker ends once, completed, and failed when its own turn failed', (order) => {
    const reorder = orders[order] as (frames: Frame[]) => Frame[];
    expect(ends(play('t3-subagent', (frame) => frame, reorder))).toEqual([expect.objectContaining({ outcome: 'completed' })]);
    expect(ends(play('t3-subagent', fail, reorder))).toEqual([expect.objectContaining({ outcome: 'failed' })]);
  });

  it('holds the first of the two for the other, and lets go of the hold when it comes', () => {
    const played = play('t3-subagent');
    const holds = played.effects.filter((effect) => effect.type === 'worker-hold' || effect.type === 'worker-settled').map((effect) => effect.type);
    expect(holds).toEqual(['worker-hold', 'worker-settled']);
    const outlived = play('m15-worker-outlives-turn');
    expect(outlived.effects.filter((effect) => effect.type === 'worker-hold' || effect.type === 'worker-settled').map((effect) => effect.type)).toEqual(['worker-hold', 'worker-settled']);
    expect(ends(outlived)).toEqual([expect.objectContaining({ outcome: 'completed' })]);
    // The turn ended while its worker ran: the closing item came for the turn that had ended.
    const turnEnd = outlived.effects.findIndex((effect) => effect.type === 'turn-ended');
    const settled = outlived.effects.findIndex((effect) => effect.type === 'worker-settled');
    expect(turnEnd).toBeGreaterThan(-1);
    expect(settled).toBeGreaterThan(turnEnd);
  });

  it('with the worker’s own end withheld, the clock’s end reports it completed', () => {
    const played = play('t3-subagent', (frame) => (isWorkerEnd(frame) ? null : frame));
    expect(ends(played)).toEqual([]);
    expect(played.effects.filter((effect) => effect.type === 'worker-hold')).toHaveLength(1);
    const [workerId] = [...played.state.workers.keys()];
    expect(expireWorker(played.state, workerId as string)).toEqual(ended(played, workerId, 'completed'));
    expect(expireWorker(played.state, workerId as string)).toEqual([]);
  });

  it('with the closing item withheld, the clock’s end reports it by its turn’s status', () => {
    const played = play('t3-subagent', (frame) => (isClosing(frame) ? null : fail(frame)));
    const [workerId] = [...played.state.workers.keys()];
    expect(expireWorker(played.state, workerId as string)).toEqual(ended(played, workerId, 'failed'));
  });

  it('an `interrupted` closing item ends it as failed, and `interacted` changes nothing', () => {
    const interrupted = play('t3-subagent', (frame) => (isClosing(frame) ? { ...frame, params: { ...(frame['params'] as object), item: { ...(at(frame, 'params', 'item') as object), kind: 'interrupted' } } } : frame));
    expect(ends(interrupted)).toEqual([expect.objectContaining({ outcome: 'failed' })]);
    const interacted = play('t3-subagent', (frame) => (isClosing(frame) ? { ...frame, params: { ...(frame['params'] as object), item: { ...(at(frame, 'params', 'item') as object), kind: 'interacted' } } } : frame));
    expect(ends(interacted)).toEqual([]);
    expect(interacted.state.workers.size).toBe(1);
  });

  it('ends every open worker as failed when its turn is stopped or lost, and discards its later frames (C90)', () => {
    const played = play('t3-subagent', (frame) => (isClosing(frame) || isWorkerEnd(frame) ? null : frame));
    const [workerId] = [...played.state.workers.keys()];
    expect(failWorkers(played.state)).toEqual(ended(played, workerId, 'failed'));
    expect(mapFrame(played.state, 'turn/completed', { threadId: workerId, turn: { id: 't', status: 'completed' } })).toEqual({ events: [], effects: [], drop: 'other-thread' });
  });

  it('learns a worker’s own turn from its turn/started, for its interrupt (C132)', () => {
    const played = play('m15-worker-interrupt');
    expect(played.state.workers.size).toBe(1);
    const [worker] = [...played.state.workers.values()];
    expect(typeof worker?.turnId).toBe('string');
    expect(worker?.turnEnd).toBe('interrupted');
  });
});

describe('what leaves the module (V2; C10)', () => {
  const PLANT = ' C:\\Users\\planted\\secret.txt && rm -rf ~ planted@example.test';
  const KEEP = new Set(['id', 'threadId', 'turnId', 'agentThreadId', 'type', 'kind', 'phase', 'status', 'method', 'clientId', 'name', 'tool']);
  /** Each planted string says which field it was planted in, so that a field which leaves can be told from one that may. */
  const planted = (key: string): string => `${PLANT} [in:${key}]`;
  /** A path, a command and an account's address planted in every string that is not an id or a kind, and in a field of its own in every object. */
  function plant(value: unknown, key?: string): unknown {
    if (typeof value === 'string') return key !== undefined && KEEP.has(key) ? value : `${value}${planted(key ?? 'none')}`;
    if (Array.isArray(value)) return value.map((item) => plant(item, key));
    if (value !== null && typeof value === 'object') return { ...Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plant(v, k)])), plantedAccount: { email: `planted@example.test${planted('email')}` }, agentPath: planted('agentPath') };
    return value;
  }
  /** The fields what was planted came out of, in an event. */
  const fieldsIn = (value: unknown): string[] => [...new Set([...JSON.stringify(value).matchAll(/\[in:([A-Za-z]+)\]/g)].map((match) => match[1] as string))].sort();
  /**
   * What may leave, and in which event. A message's text and questions are the conversation's own,
   * and an action's line is the commentary's first line. From M20a an item's own content is
   * conversation content too (C30), and goes to the chat as an activity: a command line, the paths
   * and the command of its command actions, and its output. Nothing else of a frame does.
   */
  const MAY_LEAVE: Readonly<Record<string, readonly string[]>> = {
    message: ['options', 'text', 'title'],
    'message-delta': ['delta'],
    'action-changed': ['text'],
    'activity-started': ['command', 'path'],
    'activity-ended': ['aggregatedOutput'],
  };

  it.each(['t1-basic', 't3-subagent', 't5-error', 't6-question', 'm15-saved', 'm19-worker', 'm20a-steps-main'])('%s: conversation content arrives as it was sent, and no other field holds what was planted', (name) => {
    const played = play(name, (frame) => (frame['method'] === undefined ? frame : { method: frame['method'], params: plant(frame['params']) }));
    expect(played.events.length).toBeGreaterThan(0);
    for (const event of played.events) {
      expect(AgentEventSchema.safeParse(event).success, event.type).toBe(true);
      const allowed = MAY_LEAVE[event.type] ?? [];
      expect(fieldsIn(event).filter((field) => !allowed.includes(field)), event.type).toEqual([]);
      // Never: the worker's path, an account's field, the folder a command ran in, its process, where it came from.
      expect(JSON.stringify(event), event.type).not.toMatch(/\[in:(agentPath|email|cwd|processId|source|pluginId|scriptPath)\]/);
      if (event.type === 'message' && event.role === 'assistant') expect(event.text.endsWith(planted('text'))).toBe(true);
    }
    // And the summary's route holds none of an activity's: an action's label is never a command line.
    expect(fieldsIn(actions(played)).filter((field) => field !== 'text')).toEqual([]);
    for (const effect of played.effects) {
      if (effect.type === 'turn-ended' && effect.detail !== null) continue;
      expect(JSON.stringify(effect)).not.toMatch(/planted|secret\.txt|rm -rf/);
    }
  });

  it('reads nothing of an item of a type it does not know but its type: no field of it leaves', () => {
    const played = play('t1-basic', (frame) => (at(frame, 'params', 'item', 'type') === 'commandExecution' ? { method: frame['method'], params: { ...(plant(frame['params']) as Record<string, unknown>), item: { ...(plant(at(frame, 'params', 'item')) as Record<string, unknown>), type: 'aLaterItemType' } } } : frame));
    expect(starts(played)).toEqual([expect.objectContaining({ activityType: 'other', name: 'aLaterItemType', summary: '' })]);
    expect(fieldsIn([...starts(played), ...ends(played)])).toEqual([]);
  });

  it('keeps a failed turn’s own message whole in its detail', () => {
    const played = play('t5-error', (frame) => (frame['method'] === 'turn/completed' ? { ...frame, params: { ...(frame['params'] as object), turn: { ...(at(frame, 'params', 'turn') as object), error: { message: `Plain text, not JSON.${PLANT}` } } } } : frame));
    expect(played.effects.at(-1)).toEqual({ type: 'turn-ended', status: 'failed', detail: `Plain text, not JSON.${PLANT}` });
  });
});

describe('an over-long string shortens its field and never drops its event (V46; C113)', () => {
  const edit = (phase: string, change: (item: Record<string, unknown>) => Record<string, unknown>) => (frame: Record<string, unknown>): Record<string, unknown> =>
    (frame['method'] === 'item/completed' && at(frame, 'params', 'item', 'phase') === phase ? { ...frame, params: { ...(frame['params'] as object), item: change(at(frame, 'params', 'item') as Record<string, unknown>) } } : frame);

  it('cuts an answer of 100 001 characters to its bound, and says that it was cut', () => {
    const played = play('t1-basic', edit('final_answer', (item) => ({ ...item, text: 'x'.repeat(MAX_MESSAGE_TEXT + 1) })));
    const answer = messages(played).at(-1);
    expect(answer?.text).toHaveLength(MAX_MESSAGE_TEXT);
    expect(answer?.cut).toBe(true);
    expect(AgentEventSchema.safeParse(answer).success).toBe(true);
    expect(messages(played)[1]?.cut).toBeUndefined();
  });

  it('still labels the action with a commentary over 2 000 characters: its first line, cut', () => {
    const played = play('t1-basic', edit('commentary', (item) => ({ ...item, text: `${'y'.repeat(MAX_LINE_INPUT + 500)}\nsecond line` })));
    const line = actions(played).find((event) => event.kind === 'reading')?.line;
    expect(line).toHaveLength(MAX_LINE_INPUT);
    expect(messages(played)[1]?.text).toHaveLength(MAX_LINE_INPUT + 500 + '\nsecond line'.length);
    for (const event of played.events) expect(AgentEventSchema.safeParse(event).success).toBe(true);
  });

  it('leaves out a seventeenth question and a ninth option, and cuts a title, with the cut said', () => {
    const question = { title: 'q'.repeat(MAX_QUESTION_TEXT + 1), options: Array.from({ length: 9 }, (_, i) => `option ${i}`) };
    const played = play('t6-question', (frame) => (frame['method'] === 'item/completed' && Array.isArray(at(frame, 'params', 'item', 'questions')) ? { ...frame, params: { ...(frame['params'] as object), item: { ...(at(frame, 'params', 'item') as object), questions: Array.from({ length: 17 }, () => question) } } } : frame));
    const asked = messages(played).find((event) => event.questions !== undefined);
    expect(asked?.questions).toHaveLength(16);
    expect(asked?.questions?.[0]?.options).toHaveLength(8);
    expect(asked?.questions?.[0]?.title).toHaveLength(MAX_QUESTION_TEXT);
    expect(asked?.cut).toBe(true);
    expect(AgentEventSchema.safeParse(asked).success).toBe(true);
  });
});

// ── M19: a message as it is written ───────────────────────────────────────────────────────────
// V3 (docs/planning/_archive/M19.md; C7, C8): K1's four captures, taken under the session handshake that
// keeps `item/agentMessage/delta`. Each agent message opens at its `item/started`, grows by its
// deltas and is completed by its `item/completed`, under one item id.

/** What was told of one message, in order: `open:<phase>`, `+<text>` for each delta with text, `whole:<phase>`. */
const told = (played: Played, itemId: string): string[] => played.events.flatMap((event) => {
  if (event.type === 'message-delta' && event.itemId === itemId) return [event.text === '' ? `open:${event.phase}` : `+${event.text}`];
  return event.type === 'message' && event.itemId === itemId ? [`whole:${event.phase}`] : [];
});
/** The text a message's deltas brought, put together. */
const streamedText = (played: Played, itemId: string): string => played.events.flatMap((event) => (event.type === 'message-delta' && event.itemId === itemId ? [event.text] : [])).join('');
/** A capture's agent messages on a thread, by the item id each `item/started` named, in order. */
function agentItems(name: string, threadOf: (session: string) => (thread: unknown) => boolean = (session) => (thread) => thread === session): { id: string; phase: unknown; deltas: number; text: string | null }[] {
  const capture = load(name);
  const session = String(at(capture.frames.find((f) => f.index === capture.sessionStart.replyIndex)?.frame, 'result', 'thread', 'id'));
  const own = threadOf(session);
  const received = capture.frames.filter((f) => f.dir === 'recv');
  return received.filter((f) => f.frame['method'] === 'item/started' && at(f.frame, 'params', 'item', 'type') === 'agentMessage' && own(at(f.frame, 'params', 'threadId'))).map((f) => {
    const id = String(at(f.frame, 'params', 'item', 'id'));
    const completed = received.find((g) => g.frame['method'] === 'item/completed' && at(g.frame, 'params', 'item', 'id') === id);
    return {
      id,
      phase: at(f.frame, 'params', 'item', 'phase'),
      deltas: received.filter((g) => g.frame['method'] === 'item/agentMessage/delta' && at(g.frame, 'params', 'itemId') === id).length,
      text: completed === undefined ? null : String(at(completed.frame, 'params', 'item', 'text')),
    };
  });
}

describe('K1, an answer as it is written (M19: V3; C7, C8)', () => {
  it('subscribes to the agent message’s delta and a plan’s, and to no other', () => {
    expect(MAPPED_METHODS.filter((method) => /delta/i.test(method))).toEqual(['item/agentMessage/delta', 'item/plan/delta']);
  });

  it('opens, grows and completes a commentary and a final answer, each under one id, in order and around a command (m19-answer)', () => {
    const played = play('m19-answer');
    const [commentary, answer] = agentItems('m19-answer');
    if (commentary === undefined || answer === undefined) throw new Error('the capture has no two messages');
    expect([commentary.phase, answer.phase]).toEqual(['commentary', 'final_answer']);
    expect([commentary.deltas, answer.deltas]).toEqual([12, 7]);

    // Each message: its opening with the phase `item/started` named and no text, its deltas, its whole message.
    const first = told(played, commentary.id);
    expect(first[0]).toBe('open:commentary');
    expect(first.at(-1)).toBe('whole:commentary');
    expect(first).toHaveLength(commentary.deltas + 2);
    const second = told(played, answer.id);
    expect(second[0]).toBe('open:final');
    expect(second.at(-1)).toBe('whole:final');
    expect(second).toHaveLength(answer.deltas + 2);
    // What the deltas brought is the whole text, in every message of the capture.
    expect(streamedText(played, commentary.id)).toBe(commentary.text);
    expect(streamedText(played, answer.id)).toBe(answer.text);
    expect(messages(played).filter((event) => event.role === 'assistant').map((event) => event.text)).toEqual([commentary.text, answer.text]);

    // In order, and around the command: the commentary is complete before the command's action, which is before the answer opens.
    const index = (match: (event: AgentEvent) => boolean) => played.events.findIndex(match);
    const commentaryDone = index((event) => event.type === 'message' && event.itemId === commentary.id);
    const command = index((event) => event.type === 'action-changed' && (event.kind === 'reading' || event.kind === 'running'));
    const answerOpened = index((event) => event.type === 'message-delta' && event.itemId === answer.id);
    expect(commentaryDone).toBeGreaterThan(-1);
    expect(commentaryDone).toBeLessThan(command);
    expect(command).toBeLessThan(answerOpened);

    expect(played.drops).toEqual([]);
    for (const event of played.events) {
      expect(AgentEventSchema.safeParse(event).success, event.type).toBe(true);
      if ('turnId' in event) expect(event.turnId).toBe(RUNTIME);
    }
    // The turn ends as it did before deltas: its `turn/completed`, completed.
    expect(played.effects.filter((effect) => effect.type === 'turn-ended')).toEqual([{ type: 'turn-ended', status: 'completed', detail: null }]);
  });

  it('maps every one of a long answer’s 840 deltas, which put together are its whole text (m19-markdown)', () => {
    const played = play('m19-markdown');
    const [answer] = agentItems('m19-markdown');
    if (answer === undefined) throw new Error('the capture has no message');
    expect(answer.deltas).toBe(840);
    expect(told(played, answer.id)).toHaveLength(840 + 2);
    expect(streamedText(played, answer.id)).toBe(answer.text);
    expect(answer.text).toContain('```');
    expect(played.drops).toEqual([]);
  });

  it('takes a worker’s deltas for the worker, as it does the worker’s whole messages, and none of them for the session (m19-worker; M20a, C21)', () => {
    const played = play('m19-worker');
    const own = agentItems('m19-worker');
    const workers = agentItems('m19-worker', (session) => (thread) => thread !== session);
    expect(own.map((item) => item.deltas)).toEqual([18, 19]);
    expect(workers.map((item) => item.deltas)).toEqual([20]);
    // The session's two messages streamed as its own; the worker's streamed as the worker's, and nothing was counted as dropped.
    for (const item of own) expect(streamedText(played, item.id)).toBe(item.text);
    const streamed = new Set(played.events.flatMap((event) => (event.type === 'message-delta' && event.workerId === undefined ? [event.itemId] : [])));
    expect([...streamed].sort()).toEqual(own.map((item) => item.id).sort());
    const [workerId] = played.events.flatMap((event) => (event.type === 'worker-started' ? [event.workerId] : []));
    const workersDeltas = played.events.flatMap((event) => (event.type === 'message-delta' && event.workerId !== undefined ? [event] : []));
    expect(workersDeltas.every((event) => event.workerId === workerId && event.itemId === workers[0]?.id && event.turnId === RUNTIME)).toBe(true);
    expect(workersDeltas[0]?.text).toBe('');
    expect(workersDeltas.map((event) => event.text).join('')).toBe(workers[0]?.text);
    expect(messages(played).some((event) => event.text === workers[0]?.text)).toBe(false);
    // No delta was counted as dropped: the one drop is the capture's own, the worker thread's status
    // frame that arrives before the item that announces the worker (as in T3), and it is there without the deltas too.
    const withoutDeltas = play('m19-worker', (frame) => (frame['method'] === 'item/agentMessage/delta' ? null : frame));
    expect(played.drops).toEqual(withoutDeltas.drops);
    expect(played.drops).toEqual(['other-thread']);
    // The worker itself is told as before.
    expect(types(played)).toEqual(expect.arrayContaining(['worker-started', 'worker-ended']));
  });

  it('leaves an interrupted answer open at its turn’s end: Codex sends no whole message for it (m19-interrupt)', () => {
    const played = play('m19-interrupt');
    const [answer] = agentItems('m19-interrupt');
    if (answer === undefined) throw new Error('the capture has no message');
    expect(answer).toMatchObject({ deltas: 5, text: null });
    const said = told(played, answer.id);
    expect(said[0]).toMatch(/^open:/);
    expect(said).toHaveLength(6);
    expect(said.some((entry) => entry.startsWith('whole:'))).toBe(false);
    expect(messages(played).filter((event) => event.role === 'assistant')).toEqual([]);
    expect(played.state.turn?.messages.get(answer.id)).toMatchObject({ completed: false });
    expect(played.effects.filter((effect) => effect.type === 'turn-ended')).toEqual([{ type: 'turn-ended', status: 'interrupted', detail: null }]);
    expect(played.drops).toEqual([]);
  });

  describe('whose a delta is, by its own fields (C8)', () => {
    const isDelta = (frame: Record<string, unknown>): boolean => frame['method'] === 'item/agentMessage/delta';
    /** Each delta of the capture with one field of its params changed. */
    const changing = (field: string, value: string) => (frame: Record<string, unknown>): Record<string, unknown> => (isDelta(frame) ? { ...frame, params: { ...(frame['params'] as object), [field]: value } } : frame);
    const TOTAL = 19;

    it.each([
      ['another thread’s', changing('threadId', 'some-other-thread'), 'other-thread'],
      ['another turn’s', changing('turnId', 'some-other-turn'), 'other-turn'],
      ['an item’s that no `item/started` opened', changing('itemId', 'never-opened'), 'unopened-item'],
    ])('drops and counts %s, and the whole messages still arrive', (_name, change, reason) => {
      const played = play('m19-answer', change);
      expect(played.drops).toEqual(Array.from({ length: TOTAL }, () => reason));
      expect(played.events.filter((event) => event.type === 'message-delta' && event.text !== '')).toEqual([]);
      const texts = agentItems('m19-answer').map((item) => item.text);
      expect(messages(played).filter((event) => event.role === 'assistant').map((event) => event.text)).toEqual(texts);
    });

    it('drops and counts a delta that comes after its item completed', () => {
      const [commentary] = agentItems('m19-answer');
      if (commentary === undefined) throw new Error('the capture has no message');
      // The commentary's deltas, moved to after its `item/completed`.
      const played = play('m19-answer', (frame) => frame, (frames) => {
        const late = frames.filter((entry) => isDelta(entry.frame) && at(entry.frame, 'params', 'itemId') === commentary.id);
        const rest = frames.filter((entry) => !late.includes(entry));
        const done = rest.findIndex((entry) => entry.frame['method'] === 'item/completed' && at(entry.frame, 'params', 'item', 'id') === commentary.id);
        return [...rest.slice(0, done + 1), ...late, ...rest.slice(done + 1)];
      });
      expect(played.drops).toEqual(Array.from({ length: commentary.deltas }, () => 'completed-item'));
      expect(told(played, commentary.id)).toEqual(['open:commentary', 'whole:commentary']);
    });

    it('takes no delta once its turn has ended, and drops one that is no delta frame', () => {
      const played = play('m19-interrupt');
      const [answer] = agentItems('m19-interrupt');
      const late = mapFrame(played.state, 'item/agentMessage/delta', { threadId: played.state.threadId, turnId: played.state.turn?.cliId, itemId: answer?.id, delta: 'late' });
      expect(late).toEqual({ events: [], effects: [], drop: 'other-turn' });
      expect(mapFrame(played.state, 'item/agentMessage/delta', { threadId: played.state.threadId, delta: 7 }).drop).toBe('invalid');
    });

    it('cuts a delta longer than a message’s bound, so its event passes the schema', () => {
      const played = play('m19-answer', (frame) => (isDelta(frame) ? { ...frame, params: { ...(frame['params'] as object), delta: 'x'.repeat(MAX_MESSAGE_TEXT + 50) } } : frame));
      const deltas = played.events.filter((event) => event.type === 'message-delta' && event.text !== '');
      expect(deltas).toHaveLength(TOTAL);
      for (const event of deltas) {
        expect(event.type === 'message-delta' && event.text.length).toBe(MAX_MESSAGE_TEXT);
        expect(AgentEventSchema.safeParse(event).success).toBe(true);
      }
    });
  });

  it('still gives the captures taken without deltas whole: each message opened, and completed by its whole message alone (M10, M15)', () => {
    for (const name of ['t1-basic', 't3-subagent', 't6-question', 'm15-resume', 'm15-saved']) {
      const played = play(name);
      // No text ever arrives by a delta: the opening, where the capture's `item/started` named an id, and the whole message.
      expect(played.events.filter((event) => event.type === 'message-delta' && event.text !== ''), name).toEqual([]);
      for (const message of messages(played).filter((event) => event.role === 'assistant')) {
        expect(told(played, message.itemId).filter((entry) => !entry.startsWith('open:')), name).toEqual([`whole:${message.phase}`]);
      }
      expect(played.drops.filter((reason) => reason === 'unopened-item' || reason === 'completed-item'), name).toEqual([]);
    }
  });
});

// M20a, V3 (C7, C9–C12, C14, C20, C21, C23, C24): what a session does between its messages.
describe('activities (M20a: V3)', () => {
  /** The frames a capture holds for one item, as Codex sent them. */
  const itemFrames = (name: string, type: string) => load(name).frames.filter((f) => f.dir === 'recv' && at(f.frame, 'params', 'item', 'type') === type);
  const itemOf = (frame: Frame | undefined): Record<string, unknown> => at(frame?.frame, 'params', 'item') as Record<string, unknown>;
  /** A frame of the session's own thread and turn, made here from the schema: for the item types no capture holds (C10, C12). */
  function made(method: 'item/started' | 'item/completed', state: MapperState, item: Record<string, unknown>, extra: Record<string, unknown> = {}): ReturnType<typeof mapFrame> {
    const mapped = mapFrame(state, method, { threadId: state.threadId, turnId: state.turn?.cliId, item, ...extra });
    // These legacy tables assert durable activity; M105 tests below assert live end transitions.
    return method === 'item/completed' ? { ...mapped, events: mapped.events.filter((event) => event.type !== 'action-changed' && event.type !== 'worker-progressed') } : mapped;
  }
  /** A mapping state with a turn in flight. */
  const fresh = (): MapperState => ({ threadId: 'thread-1', turn: newTurn(RUNTIME, 'cli-turn-1'), workers: new Map(), asides: new Map(), denied: new Set() });

  describe('a command, per capture (C14)', () => {
    const played = play('m20a-steps-main');
    const commands = itemFrames('m20a-steps-main', 'commandExecution');
    const startedFrames = commands.filter((f) => f.frame['method'] === 'item/started');
    const completedFrames = commands.filter((f) => f.frame['method'] === 'item/completed');
    const commandStarts = starts(played).filter((event) => event.activityType !== 'thinking');
    const commandEnds = ends(played).filter((event) => commandStarts.some((start) => start.itemId === event.itemId));

    it('opens an activity at each `item/started`: its command line as its input, its command actions’ paths as its files, Codex’s start time', () => {
      expect(commandStarts).toHaveLength(5);
      for (const [index, frame] of startedFrames.entries()) {
        const item = itemOf(frame);
        expect(commandStarts[index]).toMatchObject({ type: 'activity-started', turnId: RUNTIME, itemId: item['id'], name: 'commandExecution', input: item['command'], providerAt: at(frame.frame, 'params', 'startedAtMs') });
        expect(commandStarts[index]?.workerId).toBeUndefined();
      }
      for (const event of played.events) expect(AgentEventSchema.safeParse(event).success, event.type).toBe(true);
    });

    it('is a read when its first command action is a read, with the file’s name and its path, and a command otherwise (K1: four of five read `unknown`)', () => {
      expect(commandStarts.map((event) => event.activityType)).toEqual(['command', 'read', 'command', 'command', 'command']);
      const readItem = itemOf(startedFrames[1]);
      expect(commandStarts[1]).toMatchObject({ summary: at(readItem, 'commandActions', 0, 'name'), files: [{ path: at(readItem, 'commandActions', 0, 'path'), line: null }] });
      // A command's line is the command as Codex read it out of its shell's own line.
      expect(commandStarts[0]?.summary).toBe(at(itemOf(startedFrames[0]), 'commandActions', 0, 'command'));
      expect(commandStarts[0]?.files).toBeUndefined();
    });

    it('ends each at its `item/completed`: output, exit code, status, and Codex’s own duration, a zero included', () => {
      expect(commandEnds).toHaveLength(5);
      for (const [index, frame] of completedFrames.entries()) {
        const item = itemOf(frame);
        expect(commandEnds[index]).toEqual({ type: 'activity-ended', turnId: RUNTIME, itemId: item['id'], status: 'completed', output: item['aggregatedOutput'], exitCode: 0, providerAt: at(frame.frame, 'params', 'completedAtMs'), durationMs: item['durationMs'] });
      }
      expect(commandEnds.map((event) => event.durationMs)).toContain(0);
      expect(played.state.turn?.activities.size).toBe(0);
    });

    // M22 (V21; C76): a declined one is declined, a status of its own, whatever exit code its frame holds.
    it('fails one whose status is failed, or whose exit code is not zero, and ends a declined one as declined', () => {
      const end = (change: Record<string, unknown>) => ends(play('m20a-steps-main', (frame) => (frame['method'] === 'item/completed' && at(frame, 'params', 'item', 'id') === itemOf(completedFrames[0])['id'] ? { ...frame, params: { ...(frame['params'] as object), item: { ...itemOf(completedFrames[0]), ...change } } } : frame)))[0];
      expect(end({ status: 'failed' })).toMatchObject({ status: 'failed', exitCode: 0 });
      expect(end({ status: 'declined' })).toMatchObject({ status: 'declined' });
      expect(end({ status: 'declined', exitCode: 1 })).toMatchObject({ status: 'declined' });
      // Who declined it is not said where the session did not write that decline at the user's Deny.
      expect(end({ status: 'declined' })).not.toHaveProperty('declinedBy');
      expect(end({ exitCode: 127 })).toMatchObject({ status: 'failed', exitCode: 127 });
      expect(end({ exitCode: null, durationMs: null })).toEqual(expect.not.objectContaining({ exitCode: expect.anything() as unknown, durationMs: expect.anything() as unknown }));
    });

    it('cuts an output past its bound to its first and last half, and says so: the event passes its schema', () => {
      const output = `${'a'.repeat(15_000)}${'m'.repeat(33)}${'z'.repeat(15_000)}`;
      const [end] = ends(play('m20a-steps-main', (frame) => (frame['method'] === 'item/completed' && at(frame, 'params', 'item', 'id') === itemOf(completedFrames[0])['id'] ? { ...frame, params: { ...(frame['params'] as object), item: { ...itemOf(completedFrames[0]), aggregatedOutput: output } } } : frame)));
      expect(end?.output).toBe(`${'a'.repeat(10_000)}${'z'.repeat(10_000)}`);
      expect(end?.cut).toEqual({ fields: ['output'], output: { omitted: 10_033, at: 10_000 }, files: 0, steps: 0, changes: 0 });
      expect(AgentEventSchema.safeParse(end).success).toBe(true);
    });

    it('keeps the action line as M15 has it: the same actions, with and without the activities', () => {
      expect(actions(played).map((event) => event.kind)).toEqual(expect.arrayContaining(['running', 'reading', 'thinking', 'writing']));
      expect(actions(played).every((event) => Object.keys(event).every((key) => ['type', 'turnId', 'kind', 'line', 'file'].includes(key)))).toBe(true);
    });
  });

  describe('thinking (C9)', () => {
    it('is a thinking item with no text where the CLI sends none: every reasoning item seen is empty on both frames (K1)', () => {
      const played = play('m20a-steps-main');
      const [reasoning] = itemFrames('m20a-steps-main', 'reasoning');
      expect(itemOf(reasoning)).toMatchObject({ summary: [], content: [] });
      const thinking = starts(played).filter((event) => event.activityType === 'thinking');
      expect(thinking).toEqual([{ type: 'activity-started', turnId: RUNTIME, itemId: itemOf(reasoning)['id'], activityType: 'thinking', name: 'reasoning', summary: '', providerAt: at(reasoning?.frame, 'params', 'startedAtMs') }]);
      expect(ends(played).find((event) => event.itemId === itemOf(reasoning)['id'])).toEqual({ type: 'activity-ended', turnId: RUNTIME, itemId: itemOf(reasoning)['id'], status: 'completed', providerAt: at(itemFrames('m20a-steps-main', 'reasoning')[1]?.frame, 'params', 'completedAtMs') });
    });

    it('holds a reasoning item’s summary as its text where the CLI fills it, joined, and never anything fat-g wrote', () => {
      const state = fresh();
      const item = { type: 'reasoning', id: 'r1', summary: ['First, the files.', 'Then the tide table.'], content: [] };
      expect(made('item/started', state, { ...item, summary: [] }).events).toMatchObject([{ type: 'activity-started', activityType: 'thinking' }]);
      expect(made('item/completed', state, item).events).toEqual([{ type: 'activity-ended', turnId: RUNTIME, itemId: 'r1', status: 'completed', thinking: 'First, the files.\n\nThen the tide table.' }]);
    });
  });

  describe('the other item types, on frames made from the schema (C10, C12, C14)', () => {
    it('delivers a completed image to main separately from activity text, once, for its own turn', () => {
      const state = fresh();
      const image = { type: 'imageGeneration', id: 'img1', status: 'completed', result: 'aGVsbG8=', savedPath: 'C:\\private\\.codex\\generated.png' };
      made('item/started', state, { ...image, status: 'inProgress', result: '' });
      const end = made('item/completed', state, image).events;
      expect(end).toContainEqual({ type: 'image-returned', turnId: RUNTIME, itemId: 'img1', image: { kind: 'base64', data: image.result } });
      expect(JSON.stringify(end.filter((event) => event.type !== 'image-returned'))).not.toContain(image.result);
      expect(made('item/completed', state, image).events).toEqual([]);
      for (const event of end) expect(AgentEventSchema.safeParse(event).success).toBe(true);
    });

    it('a file change is an edit: each file’s path, the kind of change and the diff, as reported', () => {
      const state = fresh();
      const changes = [{ path: 'src/tides.js', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-old\n+new' }, { path: 'notes/new.md', kind: { type: 'add' }, diff: 'hello' }, { path: 'gone.txt', kind: 'delete', diff: null }, { path: 'odd.bin', kind: { type: 'aLaterKind' }, diff: '' }];
      expect(made('item/started', state, { type: 'fileChange', id: 'f1', status: 'inProgress', changes: [] }).events).toEqual([{ type: 'activity-started', turnId: RUNTIME, itemId: 'f1', activityType: 'edit', name: 'fileChange', summary: '' }, { type: 'action-changed', turnId: RUNTIME, kind: 'writing', tool: true }]);
      const [end] = made('item/completed', state, { type: 'fileChange', id: 'f1', status: 'completed', changes }).events;
      expect(end).toEqual({
        type: 'activity-ended', turnId: RUNTIME, itemId: 'f1', status: 'completed',
        files: [{ path: 'src/tides.js', line: null }, { path: 'notes/new.md', line: null }, { path: 'gone.txt', line: null }, { path: 'odd.bin', line: null }],
        changes: [{ path: 'src/tides.js', kind: 'update', text: '@@ -1 +1 @@\n-old\n+new' }, { path: 'notes/new.md', kind: 'add', text: 'hello' }, { path: 'gone.txt', kind: 'delete', text: null }, { path: 'odd.bin', kind: 'other', text: '' }],
      });
      expect(AgentEventSchema.safeParse(end).success).toBe(true);
      const declined = fresh();
      made('item/started', declined, { type: 'fileChange', id: 'f2', changes: [{ path: 'a.md', kind: { type: 'add' }, diff: 'x' }] });
      expect(made('item/completed', declined, { type: 'fileChange', id: 'f2', status: 'declined', changes: [] }).events).toMatchObject([{ status: 'declined' }]);
    });

    it('an MCP call names its server and tool, with its arguments as JSON text and its result as text; an image or a resource in it is a placeholder line', () => {
      const state = fresh();
      const call = { type: 'mcpToolCall', id: 'm1', server: 'docs', tool: 'search', status: 'inProgress', arguments: { query: 'tides', limit: 3 } };
      expect(made('item/started', state, call).events[0]).toEqual({ type: 'activity-started', turnId: RUNTIME, itemId: 'm1', activityType: 'mcp', name: 'docs: search', summary: 'docs: search', input: '{\n  "query": "tides",\n  "limit": 3\n}' });
      const [end] = made('item/completed', state, { ...call, status: 'completed', durationMs: 41, result: { content: [{ type: 'text', text: 'Two results.' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }, { type: 'resource', resource: { uri: 'ui://docs/app' } }] } }).events;
      expect(end).toMatchObject({ type: 'activity-ended', itemId: 'm1', status: 'completed', durationMs: 41 });
      expect(end?.type === 'activity-ended' && end.output).toBe('Two results.\n\n[An image, which fat-g does not show.]\n\n[A resource, which fat-g does not show.]');
      expect(JSON.stringify(end)).not.toContain('AAAA');
      const failing = fresh();
      made('item/started', failing, { ...call, id: 'm2' });
      expect(made('item/completed', failing, { ...call, id: 'm2', status: 'failed', error: { message: 'The server refused.' } }).events).toMatchObject([{ status: 'failed', output: 'The server refused.' }]);
    });

    it('a web search is its query', () => {
      const state = fresh();
      expect(made('item/started', state, { type: 'webSearch', id: 'w1', query: 'tide tables for the harbour' }).events[0]).toEqual({ type: 'activity-started', turnId: RUNTIME, itemId: 'w1', activityType: 'web-search', name: 'webSearch', summary: 'tide tables for the harbour', input: 'tide tables for the harbour' });
      expect(made('item/completed', state, { type: 'webSearch', id: 'w1', query: 'tide tables for the harbour' }).events).toEqual([{ type: 'activity-ended', turnId: RUNTIME, itemId: 'w1', status: 'completed' }]);
    });

    it.each(['collabAgentToolCall', 'sleep'])('%s is a wait, with nothing to open', (type) => {
      const state = fresh();
      const [start] = made('item/started', state, { type, id: 'c1', tool: 'wait', status: 'inProgress', prompt: 'PRIVATE', receiverThreadIds: [] }).events;
      expect(start).toEqual({ type: 'activity-started', turnId: RUNTIME, itemId: 'c1', activityType: 'wait', name: type, summary: 'wait' });
      expect(made('item/completed', state, { type, id: 'c1', tool: 'wait', status: 'completed' }).events).toEqual([{ type: 'activity-ended', turnId: RUNTIME, itemId: 'c1', status: 'completed' }]);
    });

    it('an image the agent looked at is a read of its one file, which the chat draws (decision 0022, item 15)', () => {
      const state = fresh();
      const item = { type: 'imageView', id: 'v1', path: 'C:\\Users\\someone\\AppData\\Local\\Temp\\fable-crop-a.png' };
      expect(made('item/started', state, item).events[0]).toEqual({ type: 'activity-started', turnId: RUNTIME, itemId: 'v1', activityType: 'read', name: 'imageView', summary: 'fable-crop-a.png', files: [{ path: item.path, line: null }] });
      expect(made('item/completed', state, item).events).toEqual([{ type: 'activity-ended', turnId: RUNTIME, itemId: 'v1', status: 'completed' }]);
      // With no path, a read of nothing.
      expect(made('item/started', fresh(), { type: 'imageView', id: 'v2' }).events[0]).toMatchObject({ activityType: 'read', summary: '' });
    });

    it.each(['aLaterItemType'])('an item of type %s is `other`, with its type as its name and nothing else read of it (C4)', (type) => {
      const state = fresh();
      const item = { type, id: 'o1', text: 'PRIVATE plan text', path: 'C:\\Users\\someone\\x.png', status: 'inProgress' };
      expect(made('item/started', state, item).events[0]).toEqual({ type: 'activity-started', turnId: RUNTIME, itemId: 'o1', activityType: 'other', name: type, summary: '' });
      expect(made('item/completed', state, { ...item, status: 'completed' }).events).toEqual([{ type: 'activity-ended', turnId: RUNTIME, itemId: 'o1', status: 'completed' }]);
    });

    it('opens an item once, and drops and counts a completion whose start never came', () => {
      const state = fresh();
      const item = { type: 'commandExecution', id: 'c1', command: 'ls', commandActions: [] };
      expect(made('item/started', state, item).events.filter((event) => event.type === 'activity-started')).toHaveLength(1);
      expect(made('item/started', state, item).events.filter((event) => event.type === 'activity-started')).toHaveLength(0);
      expect(made('item/completed', state, { ...item, id: 'never-started' })).toEqual({ events: [], effects: [], drop: 'unopened-item' });
      expect(made('item/completed', state, item).events).toHaveLength(1);
      expect(made('item/completed', state, item).drop).toBe('unopened-item');
    });

    it('makes no activity of an item with no id', () => {
      const state = fresh();
      expect(made('item/started', state, { type: 'commandExecution', command: 'ls', commandActions: [] }).events).toEqual([]);
    });
  });

  describe('the checklist (C11, C24, C59)', () => {
    const played = play('m20a-steps-tool-on-main');
    const notifications = load('m20a-steps-tool-on-main').frames.filter((f) => f.dir === 'recv' && f.frame['method'] === 'turn/plan/updated');
    const checklist = starts(played).filter((event) => event.activityType === 'checklist');

    it('subscribes to `turn/plan/updated`, which the handshake opts out of nothing for', () => {
      expect(MAPPED_METHODS).toContain('turn/plan/updated');
      expect(played.unmapped).not.toContain('turn/plan/updated');
    });

    it('maps each of the five notifications to a start for the turn’s one checklist item: the whole list each time, each step’s text and state', () => {
      expect(notifications).toHaveLength(5);
      expect(checklist).toHaveLength(5);
      expect(new Set(checklist.map((event) => event.itemId))).toEqual(new Set([`${RUNTIME}#plan`]));
      const states: Record<string, string> = { pending: 'pending', inProgress: 'in-progress', completed: 'completed' };
      for (const [index, frame] of notifications.entries()) {
        const plan = at(frame.frame, 'params', 'plan') as { step: string; status: string }[];
        expect(checklist[index]).toEqual({ type: 'activity-started', turnId: RUNTIME, itemId: `${RUNTIME}#plan`, activityType: 'checklist', name: 'plan', summary: '', steps: plan.map((step) => ({ text: step.step, state: states[step.status] })) });
        expect(AgentEventSchema.safeParse(checklist[index]).success).toBe(true);
      }
      // One step moved at each: the first is in progress at the start, and every one is completed at the end.
      expect(checklist[0]?.steps?.map((step) => step.state)).toEqual(['in-progress', 'pending', 'pending', 'pending']);
      expect(checklist.at(-1)?.steps?.every((step) => step.state === 'completed')).toBe(true);
    });

    it('sends no end for it: no frame ends a checklist, and its turn’s end completes it in main', () => {
      expect(ends(played).some((event) => event.itemId === `${RUNTIME}#plan`)).toBe(false);
      expect(played.effects.filter((effect) => effect.type === 'turn-ended')).toEqual([{ type: 'turn-ended', status: 'completed', detail: null }]);
    });

    it('reads the session’s thread and its turn in flight alone, a state it does not know as pending, and never the explanation', () => {
      const state = fresh();
      const update = (extra: Record<string, unknown>) => mapFrame(state, 'turn/plan/updated', { threadId: 'thread-1', turnId: 'cli-turn-1', explanation: 'PRIVATE explanation', plan: [{ step: 'one', status: 'aLaterStatus' }], ...extra });
      expect(update({}).events).toEqual([{ type: 'activity-started', turnId: RUNTIME, itemId: `${RUNTIME}#plan`, activityType: 'checklist', name: 'plan', summary: '', steps: [{ text: 'one', state: 'pending' }] }]);
      expect(update({ threadId: 'another-thread' })).toEqual({ events: [], effects: [], drop: 'other-thread' });
      expect(update({ turnId: 'another-turn' })).toEqual({ events: [], effects: [], drop: 'other-turn' });
      expect(update({ plan: 'not a list' })).toEqual({ events: [], effects: [], drop: 'invalid' });
      // A worker's own checklist is none of the session's.
      state.workers.set('worker-thread', newWorker(RUNTIME, 'item-w'));
      expect(update({ threadId: 'worker-thread' })).toEqual({ events: [], effects: [], drop: null });
    });

    it('cuts a list past a hundred steps and a step past its bound, and says so', () => {
      const state = fresh();
      const plan = Array.from({ length: 130 }, (_, n) => ({ step: n === 0 ? 'x'.repeat(900) : `step ${n}`, status: 'pending' }));
      const [event] = mapFrame(state, 'turn/plan/updated', { threadId: 'thread-1', turnId: 'cli-turn-1', plan }).events;
      expect(event?.type === 'activity-started' && event.steps).toHaveLength(100);
      expect(event?.type === 'activity-started' && event.cut).toEqual({ fields: ['steps'], output: null, files: 0, steps: 30, changes: 0 });
      expect(AgentEventSchema.safeParse(event).success).toBe(true);
    });

    it('brought none under the app’s launch: the captures taken with the tool off hold no notification (K1)', () => {
      for (const name of ['m20a-steps-main', 'm20a-steps-tracked-main', 'm20a-steps-tool-main']) {
        expect(starts(play(name)).filter((event) => event.activityType === 'checklist'), name).toEqual([]);
      }
    });
  });

  it('keeps the items of a turn that failed at the server: each command opened and ended before the failure (m20a-steps-tool-main)', () => {
    const played = play('m20a-steps-tool-main');
    expect(played.effects.filter((effect) => effect.type === 'turn-ended')).toMatchObject([{ status: 'failed' }]);
    const commands = starts(played).filter((event) => event.activityType === 'command' || event.activityType === 'read');
    expect(commands).toHaveLength(4);
    expect(commands.every((start) => ends(played).some((end) => end.itemId === start.itemId && end.status === 'completed'))).toBe(true);
    expect(played.drops).toEqual([]);
  });

  describe('a worker’s items (C20, C21, C23)', () => {
    const played = play('m19-worker');
    const [workerId] = played.events.flatMap((event) => (event.type === 'worker-started' ? [event.workerId] : []));
    const announcement = itemFrames('m19-worker', 'subAgentActivity').find((f) => at(f.frame, 'params', 'item', 'kind') === 'started');
    const workerItemId = itemOf(announcement)['id'];
    const owned = played.events.filter((event) => 'workerId' in event && (event.type === 'message' || event.type === 'message-delta' || event.type === 'activity-started' || event.type === 'activity-ended'));

    it('opens the worker item with the worker, paired at once, and ends it as the worker ends: its item first, then the list', () => {
      const at0 = played.events.findIndex((event) => event.type === 'worker-started');
      expect(played.events[at0 + 1]).toEqual({ type: 'activity-started', turnId: RUNTIME, itemId: workerItemId, activityType: 'worker', name: 'subAgentActivity', summary: '', pairedWorkerId: workerId, providerAt: at(announcement?.frame, 'params', 'startedAtMs') });
      // Its own `item/completed`, which comes at once, ends nothing: the worker item's end is its worker's.
      const itemEnds = ends(played).filter((event) => event.itemId === workerItemId);
      expect(itemEnds).toEqual([{ type: 'activity-ended', turnId: RUNTIME, itemId: workerItemId, status: 'completed' }]);
      const endAt = played.events.indexOf(itemEnds[0] as AgentEvent);
      expect(played.events[endAt + 1]).toEqual({ type: 'worker-ended', workerId, outcome: 'completed' });
      expect(endAt).toBeGreaterThan(played.events.findIndex((event) => event.type === 'message' && event.workerId === workerId));
      expect(JSON.stringify(played.events)).not.toContain('agentPath');
    });

    it('gives the worker thread’s command as the worker’s activity, and its message as the worker’s message, each naming the worker and the turn that started it', () => {
      const [command] = itemFrames('m19-worker', 'commandExecution');
      expect(at(command?.frame, 'params', 'threadId')).toBe(workerId);
      expect(owned.map((event) => event.type).filter((type) => type !== 'message-delta')).toEqual(['activity-started', 'activity-ended', 'message']);
      expect(owned.every((event) => 'workerId' in event && event.workerId === workerId && 'turnId' in event && event.turnId === RUNTIME)).toBe(true);
      expect(owned[0]).toMatchObject({ type: 'activity-started', activityType: 'read', itemId: itemOf(command)['id'], summary: 'notes-3.txt' });
      expect(owned.find((event) => event.type === 'activity-ended')).toMatchObject({ status: 'completed', exitCode: 0, output: expect.stringContaining('logbook') as string });
    });

    it('carries no worker’s id on the session’s own items: its waits, its messages', () => {
      const own = played.events.filter((event) => (event.type === 'activity-started' || event.type === 'activity-ended' || event.type === 'message' || event.type === 'message-delta') && !('workerId' in event));
      expect(starts(played).filter((event) => event.workerId === undefined).map((event) => event.activityType)).toEqual(['worker', 'wait', 'wait']);
      expect(own.length).toBeGreaterThan(0);
      expect(messages(played).map((event) => [event.role, event.phase])).toEqual([['user', null], ['assistant', 'commentary'], ['assistant', 'final']]);
    });

    it('never takes a worker’s `final_answer` for the turn’s answer, nor its commentary for the action line (C20)', () => {
      const workers = played.events.flatMap((event) => (event.type === 'message' && event.workerId !== undefined ? [event] : []));
      expect(workers.map((event) => event.phase)).toEqual(['final']);
      // The session's own final answer is another message, and it is the last.
      const finals = messages(played).filter((event) => event.phase === 'final');
      expect(finals).toHaveLength(1);
      expect(finals[0]?.itemId).not.toBe(workers[0]?.itemId);
      expect(finals[0]?.text).not.toBe(workers[0]?.text);
      // The action's line is the session's own commentary, before and after the worker spoke.
      const sessionCommentary = messages(played).find((event) => event.phase === 'commentary')?.text.split('\n')[0];
      for (const event of actions(played)) if (event.line !== undefined) expect(event.line).toBe(sessionCommentary);
      // With the worker's message made a commentary, the line still never becomes it.
      const relabelled = play('m19-worker', (frame) => (at(frame, 'params', 'threadId') === workerId && at(frame, 'params', 'item', 'type') === 'agentMessage' ? { ...frame, params: { ...(frame['params'] as object), item: { ...(at(frame, 'params', 'item') as object), phase: 'commentary' } } } : frame));
      const workersLine = String(workers[0]?.text).split('\n')[0];
      expect(actions(relabelled).some((event) => event.line === workersLine)).toBe(false);
    });

    it('gives a worker’s action as M15 has it, so the agent list is unchanged (C44)', () => {
      expect(played.events.filter((event) => event.type === 'worker-progressed').map((event) => event.type === 'worker-progressed' && event.kind)).toEqual(['reading', 'thinking', 'writing', 'thinking']);
    });

    it('still maps a worker’s items after the provider’s end of the turn that started it, under that turn (m15-worker-outlives-turn)', () => {
      const outlived = play('m15-worker-outlives-turn');
      const turnEnd = outlived.effects.findIndex((effect) => effect.type === 'turn-ended');
      expect(turnEnd).toBeGreaterThan(-1);
      const workers = outlived.events.filter((event) => 'workerId' in event && (event.type === 'activity-started' || event.type === 'activity-ended' || event.type === 'message'));
      expect(workers.map((event) => event.type)).toEqual(['activity-started', 'activity-ended', 'activity-started', 'activity-ended', 'message']);
      expect(workers.every((event) => 'turnId' in event && event.turnId === RUNTIME)).toBe(true);
      // Every one of them came after the session's own turn had ended.
      expect(outlived.state.turn?.ended).toBe(true);
      const worker = outlived.events.flatMap((event) => (event.type === 'activity-started' && event.activityType === 'worker' ? [event] : []))[0];
      expect(outlived.events.at(-1)).toMatchObject({ type: 'worker-ended', outcome: 'completed' });
      expect(outlived.events.at(-2)).toEqual({ type: 'activity-ended', turnId: RUNTIME, itemId: worker?.itemId, status: 'completed' });
    });

    it('drops a worker’s delta for a message that nothing opened, and the frames of a worker that has ended', () => {
      const state = fresh();
      state.workers.set('worker-thread', newWorker(RUNTIME, 'item-w'));
      expect(mapFrame(state, 'item/agentMessage/delta', { threadId: 'worker-thread', turnId: 'w-turn', itemId: 'never-opened', delta: 'x' }).drop).toBe('unopened-item');
      expect(mapFrame(state, 'item/completed', { threadId: 'worker-thread', turnId: 'w-turn', item: { type: 'commandExecution', id: 'never-started', command: 'x', commandActions: [] } }).drop).toBe('unopened-item');
      // Its instruction is no message.
      expect(mapFrame(state, 'item/completed', { threadId: 'worker-thread', turnId: 'w-turn', item: { type: 'userMessage', id: 'u', content: [{ type: 'text', text: 'Read the file.' }] } })).toEqual({ events: [], effects: [], drop: null });
      expect(failWorkers(state)).toEqual([{ type: 'activity-ended', turnId: RUNTIME, itemId: 'item-w', status: 'failed' }, { type: 'worker-ended', workerId: 'worker-thread', outcome: 'failed' }]);
      expect(mapFrame(state, 'item/started', { threadId: 'worker-thread', turnId: 'w-turn', item: { type: 'commandExecution', id: 'late', command: 'x', commandActions: [] } }).drop).toBe('other-thread');
    });
  });
});

// ── M20a, round 3 (K3): a sub-agent started through the `spawnAgent` collab tool ──────────────
describe('a worker a spawn call starts (M20a: K3; C23, C70–C72)', () => {
  const NAME = 'm20a-collab-spawn';
  const frames = load(NAME).frames.filter((f) => f.dir === 'recv');
  const collab = (tool: string, method: string) => frames.find((f) => f.frame['method'] === method && at(f.frame, 'params', 'item', 'type') === 'collabAgentToolCall' && at(f.frame, 'params', 'item', 'tool') === tool);
  const spawnStarted = collab('spawnAgent', 'item/started');
  const spawnCompleted = collab('spawnAgent', 'item/completed');
  const spawnId = String(at(spawnCompleted?.frame, 'params', 'item', 'id'));
  const worker = String(at(spawnCompleted?.frame, 'params', 'item', 'receiverThreadIds', 0));
  const played = play(NAME);
  const isSpawn = (frame: Record<string, unknown>): boolean => at(frame, 'params', 'item', 'type') === 'collabAgentToolCall' && at(frame, 'params', 'item', 'tool') === 'spawnAgent';
  const isWorkerTurnEnd = (frame: Record<string, unknown>): boolean => frame['method'] === 'turn/completed' && at(frame, 'params', 'threadId') === worker;

  it('is what the capture holds: a spawn call that names its thread only at its completion, no `subAgentActivity`, and the worker’s own turn', () => {
    expect(frames.some((f) => at(f.frame, 'params', 'item', 'type') === 'subAgentActivity')).toBe(false);
    expect(at(spawnStarted?.frame, 'params', 'item', 'receiverThreadIds')).toEqual([]);
    expect(at(spawnCompleted?.frame, 'params', 'item', 'receiverThreadIds')).toEqual([worker]);
    expect(at(spawnCompleted?.frame, 'params', 'item', 'agentsStates', worker, 'status')).toBe('pendingInit');
    expect(frames.filter((f) => isWorkerTurnEnd(f.frame))).toHaveLength(1);
    // The worker's thread speaks once before the call that started it has completed: a status change.
    const before = frames.filter((f) => f.index < (spawnCompleted?.index ?? 0) && at(f.frame, 'params', 'threadId') === worker).map((f) => f.frame['method']);
    expect(before).toEqual(['thread/status/changed', 'mcpServer/startupStatus/updated', 'mcpServer/startupStatus/updated']);
  });

  it('opens the worker’s item at the call’s start, with what the sub-agent is asked as its input, and no worker yet', () => {
    const first = starts(played).find((event) => event.itemId === spawnId);
    expect(first).toEqual({ type: 'activity-started', turnId: RUNTIME, itemId: spawnId, activityType: 'worker', name: 'spawnAgent', summary: '', input: at(spawnStarted?.frame, 'params', 'item', 'prompt'), providerAt: at(spawnStarted?.frame, 'params', 'startedAtMs') });
    expect(first?.pairedWorkerId).toBeUndefined();
    expect(played.events.indexOf(first as AgentEvent)).toBeLessThan(played.events.findIndex((event) => event.type === 'worker-started'));
    // The action is a collab call's, as it was (M15, C42).
    expect(played.events[played.events.indexOf(first as AgentEvent) + 1]).toMatchObject({ type: 'action-changed', kind: 'tool' });
  });

  it('starts the worker at the call’s completion, by the thread it names, and pairs the item with it by a second start that ends nothing', () => {
    const at0 = played.events.findIndex((event) => event.type === 'worker-started');
    // With the model its completion names, its start's being empty (M106, C15; K3).
    const model = at(spawnCompleted?.frame, 'params', 'item', 'model');
    expect(model).toBe('gpt-5.6-luna');
    expect(played.events[at0]).toEqual({ type: 'worker-started', workerId: worker, model });
    expect(played.events[at0 + 1]).toEqual({ type: 'activity-started', turnId: RUNTIME, itemId: spawnId, activityType: 'worker', name: 'spawnAgent', summary: '', input: at(spawnStarted?.frame, 'params', 'item', 'prompt'), pairedWorkerId: worker, model });
    expect(played.events.filter((event) => event.type === 'worker-started')).toHaveLength(1);
    // The call's own completion ends nothing of the item: its end is its worker's.
    expect(ends(played).filter((event) => event.itemId === spawnId)).toHaveLength(1);
  });

  it('gives the worker thread’s read and its messages as the worker’s, in the turn that started it', () => {
    const owned = played.events.filter((event) => 'workerId' in event && event.workerId === worker && (event.type === 'message' || event.type === 'activity-started' || event.type === 'activity-ended'));
    expect(owned.map((event) => [event.type, 'activityType' in event ? event.activityType : 'phase' in event ? event.phase : null])).toEqual([
      ['activity-started', 'thinking'], ['activity-ended', null], ['message', 'commentary'], ['activity-started', 'read'], ['activity-ended', null], ['message', 'final'],
    ]);
    expect(owned.every((event) => 'turnId' in event && event.turnId === RUNTIME)).toBe(true);
    expect(owned.find((event) => event.type === 'activity-started' && event.activityType === 'read')).toMatchObject({ summary: 'notes-2.txt', files: [{ path: expect.stringMatching(/notes-2\.txt$/) as string, line: null }] });
    // What it was told to do is no message of the conversation: its instruction's echo is dropped.
    expect(played.events.some((event) => event.type === 'message' && event.role === 'user' && event.workerId !== undefined)).toBe(false);
    // And its deltas are its own.
    expect(played.events.filter((event) => event.type === 'message-delta' && event.workerId === worker).length).toBeGreaterThan(2);
  });

  it('ends the worker at its own turn’s end, with no closing item to wait for: its item first, then the list, and no settle clock', () => {
    const itemEnd = ends(played).find((event) => event.itemId === spawnId);
    expect(itemEnd).toEqual({ type: 'activity-ended', turnId: RUNTIME, itemId: spawnId, status: 'completed' });
    const endAt = played.events.indexOf(itemEnd as AgentEvent);
    expect(played.events[endAt + 1]).toEqual({ type: 'worker-ended', workerId: worker, outcome: 'completed' });
    // After the worker's last message, and before the session's wait for it completes.
    expect(endAt).toBeGreaterThan(played.events.findLastIndex((event) => event.type === 'message' && event.workerId === worker));
    expect(endAt).toBeLessThan(played.events.findLastIndex((event) => event.type === 'activity-ended' && event.itemId !== spawnId && event.workerId === undefined));
    expect(played.effects.filter((effect) => effect.type === 'worker-hold')).toEqual([]);
    expect(played.effects.filter((effect) => effect.type === 'worker-settled')).toEqual([{ type: 'worker-settled', workerId: worker }]);
    expect(played.state.workers.size).toBe(0);
  });

  it('tells the wait for it as a wait, and nothing else of the session’s own as one', () => {
    const own = starts(played).filter((event) => event.workerId === undefined);
    expect(own.filter((event) => event.activityType !== 'thinking').map((event) => [event.activityType, event.name, event.summary])).toEqual([['worker', 'spawnAgent', ''], ['worker', 'spawnAgent', ''], ['wait', 'collabAgentToolCall', 'wait']]);
    expect(messages(played).map((event) => [event.role, event.phase])).toEqual([['user', null], ['assistant', 'commentary'], ['assistant', 'final']]);
    // One frame of the worker's thread came before the worker was known: a status change, dropped as another thread's.
    expect(played.drops).toEqual(['other-thread']);
    for (const event of played.events) expect(AgentEventSchema.safeParse(event).success, event.type).toBe(true);
  });

  it('fails the worker, and its item, where its own turn failed', () => {
    const failed = play(NAME, (frame) => (isWorkerTurnEnd(frame) ? { ...frame, params: { ...(frame['params'] as object), turn: { ...(at(frame, 'params', 'turn') as object), status: 'failed' } } } : frame));
    expect(ends(failed).find((event) => event.itemId === spawnId)).toMatchObject({ status: 'failed' });
    expect(failed.events.find((event) => event.type === 'worker-ended')).toEqual({ type: 'worker-ended', workerId: worker, outcome: 'failed' });
  });

  it('keeps the worker open past its session’s turn where its own turn’s end never comes, and ends it as failed with every open worker', () => {
    const open = play(NAME, (frame) => (isWorkerTurnEnd(frame) ? null : frame));
    expect(open.events.some((event) => event.type === 'worker-ended')).toBe(false);
    expect(ends(open).some((event) => event.itemId === spawnId)).toBe(false);
    expect([...open.state.workers.keys()]).toEqual([worker]);
    expect(open.effects.some((effect) => effect.type === 'worker-hold')).toBe(false);
    expect(failWorkers(open.state)).toEqual([{ type: 'activity-ended', turnId: RUNTIME, itemId: spawnId, status: 'failed' }, { type: 'worker-ended', workerId: worker, outcome: 'failed' }]);
  });

  it('ends the item as a launch that failed where the call started none: a failed status, or no thread named', () => {
    const refused = play(NAME, (frame) => (isSpawn(frame) && frame['method'] === 'item/completed' ? { ...frame, params: { ...(frame['params'] as object), item: { ...(at(frame, 'params', 'item') as object), status: 'failed', receiverThreadIds: [], agentsStates: {} } } } : frame));
    expect(refused.events.some((event) => event.type === 'worker-started')).toBe(false);
    expect(ends(refused).find((event) => event.itemId === spawnId)).toEqual({ type: 'activity-ended', turnId: RUNTIME, itemId: spawnId, status: 'failed', providerAt: at(spawnCompleted?.frame, 'params', 'completedAtMs') });
    expect(starts(refused).filter((event) => event.itemId === spawnId).map((event) => event.pairedWorkerId)).toEqual([undefined]);
    // The thread it never started is no worker: its frames are another thread's.
    expect(refused.events.some((event) => 'workerId' in event && event.workerId !== undefined)).toBe(false);
    expect(refused.drops.every((drop) => drop === 'other-thread')).toBe(true);

    const nameless = play(NAME, (frame) => (isSpawn(frame) && frame['method'] === 'item/completed' ? { ...frame, params: { ...(frame['params'] as object), item: { ...(at(frame, 'params', 'item') as object), receiverThreadIds: [] } } } : frame));
    expect(nameless.events.some((event) => event.type === 'worker-started')).toBe(false);
    expect(ends(nameless).find((event) => event.itemId === spawnId)).toMatchObject({ status: 'completed' });
  });

  it('opens the item at the completion where no start came, paired at once', () => {
    const late = play(NAME, (frame) => (isSpawn(frame) && frame['method'] === 'item/started' ? null : frame));
    expect(starts(late).filter((event) => event.itemId === spawnId)).toMatchObject([{ activityType: 'worker', pairedWorkerId: worker }]);
    expect(late.events.filter((event) => event.type === 'worker-started')).toHaveLength(1);
  });

  it('tells any other collab tool by its name, and never as a wait', () => {
    const other = play(NAME, (frame) => (at(frame, 'params', 'item', 'tool') === 'wait' ? { ...frame, params: { ...(frame['params'] as object), item: { ...(at(frame, 'params', 'item') as object), tool: 'closeAgent' } } } : frame));
    expect(starts(other).filter((event) => event.name === 'closeAgent')).toMatchObject([{ activityType: 'other', summary: '' }]);
    expect(starts(other).some((event) => event.activityType === 'wait')).toBe(false);
  });
});

// ── M21: a question ───────────────────────────────────────────────────────────────────────────
// V5, V20 (docs/planning/_archive/M21.md, Design 4; C23, C27, C56, C69): K2's captures. The request is the
// session's to answer and no frame of the mapper's; what is mapped is Codex's word that a request
// is over, and the messages of a turn that asks in one.
describe('K2, a question (M21: V5, V20; C23, C27, C56, C69)', () => {
  const resolvedOf = (played: Played) => played.effects.filter((effect) => effect.type === 'request-resolved');
  /** A capture's first turn alone: the frames before its second `turn/start`, where it has one. */
  const firstTurn = (name: string) => (frames: Frame[]): Frame[] => {
    const second = load(name).frames.filter((f) => f.dir === 'send' && f.frame['method'] === 'turn/start')[1];
    return second === undefined ? frames : frames.filter((f) => f.index < second.index);
  };

  it('subscribes to Codex’s word that a request is over, and gives it back as an effect naming the request: its number as a string (m21-codex-plan)', () => {
    expect(MAPPED_METHODS).toContain('serverRequest/resolved');
    const played = play('m21-codex-plan');
    expect(resolvedOf(played)).toEqual([{ type: 'request-resolved', requestId: 'n:0' }]);
    expect(played.unmapped).not.toContain('serverRequest/resolved');
    // The request itself is none of the mapper's frames, and no event of a question comes from here.
    expect(played.unmapped).toContain('item/tool/requestUserInput');
    expect(types(played).filter((type) => type.startsWith('question'))).toEqual([]);
    // A plan turn's items are the echo and its plan (K2): no agent message, and the plan as a plan (M22b, C14), no activity.
    expect(messages(played).map((event) => event.role)).toEqual(['user']);
    expect(starts(played)).toEqual([]);
    expect(ends(played)).toEqual([]);
    expect(types(played).filter((type) => type.startsWith('plan-'))).toEqual(['plan-delta', 'plan-completed']);
    // While the request was pending the thread stayed active, `waitingOnUserInput` its flag: no end is taken from that.
    expect(played.effects.flatMap((effect) => (effect.type === 'active' || effect.type === 'inactive' ? [effect.type] : []))).toEqual(['active', 'active', 'active', 'inactive']);
    expect(played.effects.at(-1)).toEqual({ type: 'turn-ended', status: 'completed', detail: null });
    expect(played.drops).toEqual([]);
    for (const event of played.events) expect(AgentEventSchema.safeParse(event).success, event.type).toBe(true);
  });

  it('takes the same word after the turn’s end, where K2 interrupted the turn with the request pending (m21-codex-plan-stop; C27)', () => {
    const played = play('m21-codex-plan-stop');
    expect(played.effects.flatMap((effect) => (effect.type === 'turn-ended' ? [`${effect.type}:${effect.status}`] : effect.type === 'request-resolved' ? [`${effect.type}:${effect.requestId}`] : []))).toEqual(['turn-ended:interrupted', 'request-resolved:n:0']);
    expect(played.drops).toEqual([]);
  });

  it('names a request by the id it came with, a string as it is, and drops a word that names none, counted', () => {
    const state: MapperState = { threadId: 'thread-a', turn: newTurn(RUNTIME, 'cli-turn'), workers: new Map(), asides: new Map(), denied: new Set() };
    expect(mapFrame(state, 'serverRequest/resolved', { threadId: 'thread-a', requestId: 'req-7' })).toEqual({ events: [], effects: [{ type: 'request-resolved', requestId: 's:req-7' }], drop: null });
    // Whichever thread it names: a worker's request is resolved on the worker's.
    expect(mapFrame(state, 'serverRequest/resolved', { threadId: 'some-other-thread', requestId: 12 }).effects).toEqual([{ type: 'request-resolved', requestId: 'n:12' }]);
    for (const params of [{ threadId: 'thread-a' }, { threadId: 'thread-a', requestId: null }, { threadId: 'thread-a', requestId: '' }, { threadId: 'thread-a', requestId: 'x'.repeat(300) }, { threadId: 'thread-a', requestId: { id: 1 } }, null]) {
      expect(mapFrame(state, 'serverRequest/resolved', params)).toEqual({ events: [], effects: [], drop: 'invalid' });
    }
  });

  it.each(['m21-codex-async', 'm21-codex-async-two'])('%s: opens the empty message its turn ends with as it opens every message, and gives it whole at its completion — what it is, with no text and no questions (C56, C69)', (name) => {
    const played = play(name, (frame) => frame, firstTurn(name));
    const [asking, trailer] = agentItems(name);
    if (asking === undefined || trailer === undefined) throw new Error('the capture has no two messages');
    // K2: the message that asks came whole, with no delta; the one after it holds nothing at all.
    expect([asking.deltas, trailer.deltas, trailer.text]).toEqual([0, 0, '']);
    expect(told(played, asking.id)).toEqual(['open:final', 'whole:final']);
    const whole = messages(played).find((event) => event.itemId === asking.id);
    expect(whole?.text).toBe(asking.text);
    expect(whole?.questions?.map((question) => question.options)).toEqual(Array.from({ length: name === 'm21-codex-async' ? 1 : 2 }, (_, n) => (n === 0 ? ['notes-1.txt', 'notes-2.txt'] : ['Quoted', 'Summarised'])));
    // The start is what opens a message for its deltas, so the trailer's is taken too; its completion
    // says what it is, and main lets go of a whole message that says nothing.
    expect(told(played, trailer.id)).toEqual(['open:final', 'whole:final']);
    expect(messages(played).find((event) => event.itemId === trailer.id)).toEqual({ type: 'message', turnId: RUNTIME, role: 'assistant', itemId: trailer.id, phase: 'final', text: '' });
    expect(messages(played).filter((event) => event.role === 'assistant')).toHaveLength(2);
    expect(played.drops).toEqual([]);
    expect(played.effects.filter((effect) => effect.type === 'turn-ended')).toEqual([{ type: 'turn-ended', status: 'completed', detail: null }]);
    for (const event of played.events) expect(AgentEventSchema.safeParse(event).success, event.type).toBe(true);
  });

  it('still streams a message that starts empty and is then written: the answering turn’s commentary and its answer, by their deltas (m21-codex-async)', () => {
    const capture = load('m21-codex-async');
    const second = capture.frames.filter((f) => f.dir === 'send' && f.frame['method'] === 'turn/start')[1] as Frame;
    const reply = capture.frames.find((f) => f.dir === 'recv' && f.frame['method'] === undefined && f.frame['id'] === second.frame['id']) as Frame;
    const session = String(at(capture.frames.find((f) => f.index === capture.sessionStart.replyIndex)?.frame, 'result', 'thread', 'id'));
    const state: MapperState = { threadId: session, turn: newTurn(RUNTIME, String(at(reply.frame, 'result', 'turn', 'id'))), workers: new Map(), asides: new Map(), denied: new Set() };
    const events: AgentEvent[] = [];
    for (const f of capture.frames.filter((entry) => entry.dir === 'recv' && entry.index > reply.index && isMapped(entry.frame['method']))) events.push(...mapFrame(state, f.frame['method'] as MappedMethod, f.frame['params']).events);
    const [, , commentary, answer] = agentItems('m21-codex-async');
    if (commentary === undefined || answer === undefined) throw new Error('the capture’s second turn has no two messages');
    expect([commentary.deltas, answer.deltas]).toEqual([8, 18]);
    for (const item of [commentary, answer]) {
      const said = told({ events, drops: [], effects: [], unmapped: [], state }, item.id);
      expect(said[0]).toMatch(/^open:/);
      expect(said.at(-1)).toMatch(/^whole:/);
      expect(said).toHaveLength(item.deltas + 2);
      expect(streamedText({ events, drops: [], effects: [], unmapped: [], state }, item.id)).toBe(item.text);
    }
  });
});

// M22 (V21, V34; C76, C96): a declined action, and Codex's own reviewer.
describe('K1 and K4, what a session may do (M22: V21, V34; C76, C96)', () => {
  it('ends K1’s declined command as declined, as its capture has it, and the accepted one before it by Codex’s own status (m22-codex-once)', () => {
    const capture = load('m22-codex-once');
    const second = capture.frames.filter((f) => f.dir === 'send' && f.frame['method'] === 'turn/start')[1] as Frame;
    // The first turn: accepted, and it ran.
    const first = play('m22-codex-once', (frame) => frame, (frames) => frames.filter((f) => f.index < second.index));
    expect(ends(first).filter((event) => event.exitCode !== undefined).map((event) => [event.status, event.exitCode])).toEqual([['completed', 0]]);
    // The second: declined. Its item ended `declined`, with no exit code, and the turn completed all the same.
    const reply = capture.frames.find((f) => f.dir === 'recv' && f.frame['method'] === undefined && f.frame['id'] === second.frame['id']) as Frame;
    const session = String(at(capture.frames.find((f) => f.index === capture.sessionStart.replyIndex)?.frame, 'result', 'thread', 'id'));
    const state: MapperState = { threadId: session, turn: newTurn(RUNTIME, String(at(reply.frame, 'result', 'turn', 'id'))), workers: new Map(), asides: new Map(), denied: new Set() };
    const events: AgentEvent[] = [];
    const effects: MapperEffect[] = [];
    for (const f of capture.frames.filter((entry) => entry.dir === 'recv' && entry.index > reply.index && isMapped(entry.frame['method']))) {
      const mapped = mapFrame(state, f.frame['method'] as MappedMethod, f.frame['params']);
      events.push(...mapped.events);
      effects.push(...mapped.effects);
    }
    const declined = events.flatMap((event) => (event.type === 'activity-ended' && event.status === 'declined' ? [event] : []));
    expect(declined).toHaveLength(1);
    expect(declined[0]).not.toHaveProperty('exitCode');
    expect(declined[0]).not.toHaveProperty('declinedBy');
    expect(effects.at(-1)).toEqual({ type: 'turn-ended', status: 'completed', detail: null });
    // Codex's word for each request is given back, by the request's lossless id.
    expect(effects.flatMap((effect) => (effect.type === 'request-resolved' ? [effect.requestId] : []))).toEqual(['n:1']);
    for (const event of events) expect(AgentEventSchema.safeParse(event).success, event.type).toBe(true);
  });

  it('names the user as who declined an item the session says they denied, once, and no one for any other', () => {
    const fresh = (): MapperState => ({ threadId: 'thread-1', turn: newTurn(RUNTIME, 'cli-turn-1'), workers: new Map(), asides: new Map(), denied: new Set() });
    const item = (state: MapperState, method: 'item/started' | 'item/completed', id: string, status: string, threadId = state.threadId, turnId: string | undefined = state.turn?.cliId) => mapFrame(state, method, { threadId, turnId, item: { type: 'fileChange', id, status, changes: [{ path: 'a.md', kind: { type: 'add' }, diff: 'x' }] } });
    const state = fresh();
    item(state, 'item/started', 'f1', 'inProgress');
    item(state, 'item/started', 'f2', 'inProgress');
    state.denied.add('f1');
    expect(item(state, 'item/completed', 'f1', 'declined').events).toMatchObject([{ type: 'activity-ended', itemId: 'f1', status: 'declined', declinedBy: 'user' }]);
    expect(item(state, 'item/completed', 'f2', 'declined').events[0]).toEqual(expect.not.objectContaining({ declinedBy: expect.anything() as unknown }));
    expect(state.denied.size).toBe(0);
    // A denied item that Codex ran all the same keeps Codex's status, and names no one.
    const ran = fresh();
    item(ran, 'item/started', 'f3', 'inProgress');
    ran.denied.add('f3');
    const [end] = item(ran, 'item/completed', 'f3', 'completed').events;
    expect(end).toMatchObject({ status: 'completed' });
    expect(end).not.toHaveProperty('declinedBy');
    expect(ran.denied.size).toBe(0);
    // A worker's item is told the same way.
    const worker = fresh();
    worker.workers.set('worker-1', newWorker(RUNTIME));
    item(worker, 'item/started', 'f4', 'inProgress', 'worker-1', 'worker-turn');
    worker.denied.add('f4');
    expect(item(worker, 'item/completed', 'f4', 'declined', 'worker-1', 'worker-turn').events).toMatchObject([{ status: 'declined', declinedBy: 'user', workerId: 'worker-1' }, { type: 'worker-progressed', kind: 'thinking' }]);
  });

  it('maps none of the reviewer’s three frames: K4’s turn under Codex’s own reviewer makes no card, notice or item of them (m22-codex-auto-review-main)', () => {
    expect([...REVIEW_METHODS]).toEqual(['item/autoApprovalReview/started', 'item/autoApprovalReview/completed', 'guardianWarning']);
    for (const method of REVIEW_METHODS) expect(isMapped(method), method).toBe(false);
    const played = play('m22-codex-auto-review-main');
    // They came, in K4's order, and none reached the mapper.
    expect(played.unmapped.filter((method) => (REVIEW_METHODS as readonly string[]).includes(method))).toEqual(['item/autoApprovalReview/started', 'guardianWarning', 'item/autoApprovalReview/completed']);
    // No request came to the client, and nothing of a review is an event: the reviewed change's own item is the chat's record.
    expect(played.unmapped).not.toContain('item/fileChange/requestApproval');
    expect(types(played).filter((type) => /approval|question|notice/.test(type))).toEqual([]);
    expect(JSON.stringify(played.events)).not.toMatch(/Automatic approval review|riskLevel|rationale/);
    const edits = starts(played).filter((event) => event.activityType === 'edit');
    expect(edits).toHaveLength(1);
    expect(ends(played).find((event) => event.itemId === edits[0]?.itemId)).toMatchObject({ status: 'completed' });
    expect(played.drops).toEqual([]);
    for (const event of played.events) expect(AgentEventSchema.safeParse(event).success, event.type).toBe(true);
  });

  it('maps a turn of every M22 capture into events that pass the schema, a declined item among them where one was declined', () => {
    const names = ['m22-codex-files', 'm22-codex-ask-first-files', 'm22-codex-sandbox-files', 'm22-codex-sandbox-commands', 'm22-codex-sandbox-ask-first', 'm22-codex-sandbox-ask-write', 'm22-codex-sandbox-temp', 'm22-codex-reviewer-turn-main', 'm22-codex-read-only-turn', 'm22-codex-berserk-main', 'm22-codex-worker', 'm22-codex-on-request', 'm22-codex-file-session-same-main'];
    const statuses = new Set<string>();
    for (const name of names) {
      const played = play(name);
      for (const event of played.events) expect(AgentEventSchema.safeParse(event).success, `${name} ${event.type}`).toBe(true);
      for (const event of ends(played)) statuses.add(event.status);
      expect(played.effects.some((effect) => effect.type === 'turn-ended'), name).toBe(true);
    }
    expect([...statuses].sort()).toEqual(['completed', 'declined', 'failed']);
  });
});

// ── M106: the model a sub-agent runs on ───────────────────────────────────────────────────────
// V3 (docs/planning/_archive/M106.md, Design 2; C15): K2's two captures — a `spawnAgent` call on
// `gpt-5.6-luna` asking for `gpt-5.6-terra`, and a `subAgentActivity` under `gpt-6-astra` — and the
// same frames changed here for a model left out, empty or no key.
describe('the model a sub-agent runs on (M106: V3)', () => {
  const item = (frame: Record<string, unknown>): Record<string, unknown> | null => (at(frame, 'params', 'item') as Record<string, unknown> | undefined) ?? null;
  /** The capture's frames with each collab call's or activity's `model` replaced, on its start, its completion, or both. */
  const withModel = (name: string, model: unknown, method?: string) => play(name, (frame) => {
    const own = item(frame);
    if (own === null || (own['type'] !== 'collabAgentToolCall' && own['type'] !== 'subAgentActivity') || (method !== undefined && frame['method'] !== method)) return frame;
    return { ...frame, params: { ...(frame['params'] as Record<string, unknown>), item: { ...own, model } } };
  });
  const workersOf = (played: Played) => played.events.filter((event) => event.type === 'worker-started');
  const valid = (played: Played): void => { for (const event of played.events) expect(AgentEventSchema.safeParse(event).success, JSON.stringify(event).slice(0, 120)).toBe(true); };

  it('starts a spawned sub-agent with the model its call asked for, on the worker and its item, at the call’s completion', () => {
    const played = play('m106-codex-spawn');
    expect(workersOf(played)).toEqual([{ type: 'worker-started', workerId: '<worker-9>', model: 'gpt-5.6-terra' }]);
    expect(starts(played).filter((event) => event.itemId === '<item-8>').map((event) => [event.pairedWorkerId ?? null, event.model ?? null])).toEqual([[null, null], ['<worker-9>', 'gpt-5.6-terra']]);
    // No `worker-model`: the worker's thread names none.
    expect(played.events.some((event) => event.type === 'worker-model')).toBe(false);
    valid(played);
  });

  it('falls back to the model the call’s start named, and names none where neither did or one was no key', () => {
    expect(workersOf(withModel('m106-codex-spawn', null, 'item/completed'))).toEqual([{ type: 'worker-started', workerId: '<worker-9>', model: 'gpt-5.6-terra' }]);
    // An empty one, as the 0.155.1 call's start carried (K3), names nothing and loses no sub-agent.
    for (const model of ['', 'two words', 7, null, 'x'.repeat(129)]) {
      const played = withModel('m106-codex-spawn', model);
      expect(workersOf(played), String(model)).toEqual([{ type: 'worker-started', workerId: '<worker-9>' }]);
      expect(starts(played).some((event) => event.model !== undefined), String(model)).toBe(false);
      valid(played);
    }
  });

  it('starts an announced sub-agent with the model its `started` kind names, and takes nothing from its `completed` kind', () => {
    const played = play('m106-codex-activity');
    expect(workersOf(played)).toEqual([{ type: 'worker-started', workerId: '<worker-6>', model: 'gpt-6-astra' }]);
    expect(starts(played).filter((event) => event.activityType === 'worker').map((event) => [event.itemId, event.pairedWorkerId ?? null, event.model ?? null])).toEqual([['<item-7>', '<worker-6>', 'gpt-6-astra']]);
    expect(played.events.some((event) => event.type === 'worker-model')).toBe(false);
    valid(played);
    for (const model of ['', 'two words', 7]) expect(workersOf(withModel('m106-codex-activity', model)), String(model)).toEqual([{ type: 'worker-started', workerId: '<worker-6>' }]);
  });
});
