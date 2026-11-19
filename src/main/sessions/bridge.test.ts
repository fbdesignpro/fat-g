// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V2, V14, V46 (docs/planning/_archive/M15.md; C10, C47, C113) and V26 (M18.md; C47, C59): the bridge. Every normalized event becomes
// M14's source events and the chat's changes, and conversation text reaches the summary by one
// route alone, an action's line. The same on the captures, end to end, is in tests/codex/.
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@shared/contracts/agent-events';
import { MAX_LINE_INPUT, SessionEventSchema } from '@shared/contracts/sessions';
import { bridge, firstPromptName } from './bridge';

const S = '5e551000-0000-4000-8000-000000000001';
const PRIVATE = 'C:\\Users\\someone\\secret.txt and rm -rf ~ and someone@example.test';

describe('the bridge (V14)', () => {
  const cases: [AgentEvent, { session: unknown[]; chat: unknown[] }][] = [
    [{ type: 'session-started', reference: 'ref-1', folder: 'D:\\Code\\fat-g' }, { session: [{ type: 'reference-set', sessionId: S, reference: 'ref-1', folder: 'D:\\Code\\fat-g' }], chat: [] }],
    [{ type: 'turn-started', turnId: 't1' }, { session: [], chat: [] }],
    [{ type: 'message', turnId: 't1', role: 'assistant', itemId: 'i1', phase: 'commentary', text: 'Reading.' }, { session: [], chat: [{ kind: 'assistant', turnId: 't1', itemId: 'i1', workerId: null, phase: 'commentary', text: 'Reading.', cut: false, questions: [], model: null }] }],
    [{ type: 'message', turnId: 't1', role: 'assistant', itemId: 'i2', phase: 'final', text: 'Done.', cut: true, questions: [{ title: 'Q', options: ['a'] }] }, { session: [], chat: [{ kind: 'assistant', turnId: 't1', itemId: 'i2', workerId: null, phase: 'final', text: 'Done.', cut: true, questions: [{ title: 'Q', options: ['a'] }], model: null }] }],
    [{ type: 'message', turnId: 't1', role: 'user', itemId: 'u1', phase: null, text: 'Hello', clientId: 'm1' }, { session: [], chat: [{ kind: 'echo', itemId: 'u1', clientId: 'm1' }] }],
    [{ type: 'message', turnId: 't1', role: 'user', itemId: 'u1', phase: null, text: 'Hello' }, { session: [], chat: [{ kind: 'echo', itemId: 'u1', clientId: null }] }],
    [{ type: 'action-changed', turnId: 't1', kind: 'reading', line: 'I will read it', file: 'sample.txt' }, { session: [{ type: 'action-changed', sessionId: S, turnId: 't1', kind: 'reading', line: 'I will read it', file: 'sample.txt' }], chat: [] }],
    [{ type: 'action-changed', turnId: 't1', kind: 'thinking' }, { session: [{ type: 'action-changed', sessionId: S, turnId: 't1', kind: 'thinking' }], chat: [] }],
    [{ type: 'action-changed', turnId: 't1', kind: 'waiting', wait: { reason: 'subagents', count: 2 } }, { session: [{ type: 'action-changed', sessionId: S, turnId: 't1', kind: 'waiting', wait: { reason: 'subagents', count: 2 } }], chat: [] }],
    [{ type: 'action-changed', turnId: 't1', kind: 'writing', tool: true }, { session: [{ type: 'action-changed', sessionId: S, turnId: 't1', kind: 'writing', tool: true }], chat: [] }],
    [{ type: 'worker-started', workerId: 'w1' }, { session: [{ type: 'worker-started', sessionId: S, workerId: 'w1' }], chat: [] }],
    [{ type: 'worker-started', workerId: 'w1', description: 'reads notes' }, { session: [{ type: 'worker-started', sessionId: S, workerId: 'w1', description: 'reads notes' }], chat: [] }],
    [{ type: 'worker-progressed', workerId: 'w1', kind: 'reading', file: 'notes.txt' }, { session: [{ type: 'worker-progressed', sessionId: S, workerId: 'w1', kind: 'reading', file: 'notes.txt' }], chat: [] }],
    [{ type: 'worker-progressed', workerId: 'w1', kind: 'waiting', wait: { reason: 'provider' } }, { session: [{ type: 'worker-progressed', sessionId: S, workerId: 'w1', kind: 'waiting', wait: { reason: 'provider' } }], chat: [] }],
    [{ type: 'worker-ended', workerId: 'w1', outcome: 'failed' }, { session: [{ type: 'worker-ended', sessionId: S, workerId: 'w1', outcome: 'failed' }], chat: [] }],
    [{ type: 'in-force', turnId: 't1', model: 'other-model', effort: null }, { session: [{ type: 'in-force', sessionId: S, model: 'other-model', effort: null }], chat: [] }],
    // Decision 0033: a context reading is the summary's alone.
    [{ type: 'context', reading: { used: 15_800, window: 258_400, lastCall: { input: 3_203, cacheRead: 12_544, output: 53 } } }, { session: [{ type: 'context', sessionId: S, reading: { used: 15_800, window: 258_400, lastCall: { input: 3_203, cacheRead: 12_544, output: 53 } } }], chat: [] }],
    [{ type: 'notice', turnId: 't1', kind: 'turn-failed', detail: 'The model is not supported.' }, { session: [], chat: [{ kind: 'notice', turnId: 't1', notice: 'turn-failed', step: null, detail: 'The model is not supported.', bound: null, size: null }] }],
    [{ type: 'notice', kind: 'start-failed', step: 'reopen' }, { session: [], chat: [{ kind: 'notice', turnId: null, notice: 'start-failed', step: 'reopen', detail: null, bound: null, size: null }] }],
    [{ type: 'turn-ended', turnId: 't1', outcome: 'failed', reported: false, failure: 'connection-lost' }, { session: [{ type: 'turn-ended', sessionId: S, turnId: 't1', outcome: 'failed' }], chat: [] }],
  ];

  it.each(cases.map(([event, expected]) => [event.type, event, expected] as const))('%s', (_type, event, expected) => {
    const bridged = bridge(S, event);
    expect(bridged.session).toEqual(expected.session);
    expect(bridged.chat).toEqual(expected.chat);
    // What it hands the session service is what M14's schema takes.
    for (const sessionEvent of bridged.session) expect(SessionEventSchema.safeParse(sessionEvent).success, sessionEvent.type).toBe(true);
  });

  it('says which reference to keep, and which turn ended and how', () => {
    expect(bridge(S, { type: 'session-started', reference: 'ref-1', folder: '/p' }).reference).toEqual({ reference: 'ref-1', folder: '/p' });
    expect(bridge(S, { type: 'turn-ended', turnId: 't1', outcome: 'failed', reported: false, failure: 'end-lost' }).ended).toEqual({ turnId: 't1', outcome: 'failed', failure: 'end-lost', reported: false, answerItemId: null });
    expect(bridge(S, { type: 'turn-ended', turnId: 't1', outcome: 'completed', reported: true }).ended).toEqual({ turnId: 't1', outcome: 'completed', failure: null, reported: true, answerItemId: null });
    expect(bridge(S, { type: 'turn-started', turnId: 't1' })).toMatchObject({ reference: null, ended: null });
  });

  it('passes the answer’s id on for an end that is reported and completed, and for no other (M16, C74)', () => {
    const end = { type: 'turn-ended', turnId: 't1', answerItemId: 'item-9' } as const;
    expect(bridge(S, { ...end, outcome: 'completed', reported: true }).ended).toEqual({ turnId: 't1', outcome: 'completed', failure: null, reported: true, answerItemId: 'item-9' });
    // An end the adapter made, and one that is not completed, settles nothing, whatever it carries.
    expect(bridge(S, { ...end, outcome: 'completed', reported: false }).ended?.answerItemId).toBeNull();
    expect(bridge(S, { ...end, outcome: 'interrupted', reported: true }).ended?.answerItemId).toBeNull();
    expect(bridge(S, { ...end, outcome: 'failed', reported: true, failure: 'turn-failed' }).ended?.answerItemId).toBeNull();
    // The summary and the record take the end as before: the id is the chat's alone.
    expect(bridge(S, { ...end, outcome: 'completed', reported: true }).session).toEqual([{ type: 'turn-ended', sessionId: S, turnId: 't1', outcome: 'completed' }]);
  });

  it('says that the provider took the prompt, with its own id for the turn where it gave one (M18, C47)', () => {
    expect(bridge(S, { type: 'turn-started', turnId: 't1', providerTurnId: 'provider-turn-9' }).taken).toEqual({ turnId: 't1', providerTurnId: 'provider-turn-9' });
    expect(bridge(S, { type: 'turn-started', turnId: 't1' }).taken).toEqual({ turnId: 't1', providerTurnId: null });
    expect(bridge(S, { type: 'turn-ended', turnId: 't1', outcome: 'completed', reported: true }).taken).toBeNull();
  });

  it('hands the summary every end alike, and passes on whose it was (M18, C59)', () => {
    const own = bridge(S, { type: 'turn-ended', turnId: 't1', outcome: 'interrupted', reported: false });
    const providers = bridge(S, { type: 'turn-ended', turnId: 't1', outcome: 'interrupted', reported: true });
    expect(own.session).toEqual(providers.session);
    expect([own.ended?.reported, providers.ended?.reported]).toEqual([false, true]);
    // What whose it was is not the summary's to know: its event has no such field.
    expect(JSON.stringify(own.session)).not.toContain('reported');
  });

  it('raises no question and no approval: no request event comes out of it (C46)', () => {
    const all = cases.flatMap(([event]) => bridge(S, event).session.map((sessionEvent) => sessionEvent.type));
    expect(all).not.toContain('request-raised');
    expect(all).not.toContain('request-resolved');
  });

  // M21, V8 (C10, C20): a question asked as a request is the request registry's, which the runtime
  // hands both events before any reaches here.
  it('gives nothing for a question event: nothing for the summary, nothing for the chat, no turn taken or ended', () => {
    const raised = bridge(S, { type: 'question-raised', turnId: 't1', requestId: 'request-1', sourceId: 'toolu_1', questions: [{ text: PRIVATE, header: PRIVATE, options: [{ label: PRIVATE, description: PRIVATE }], multiple: false, freeText: true, secret: false }], cut: false });
    for (const bridged of [raised, bridge(S, { type: 'question-raised', turnId: 't1', workerId: 'w1', requestId: 'request-2', sourceId: 'toolu_2', questions: [{ text: 'q', header: null, options: [], multiple: false, freeText: true, secret: false }], cut: false }), ...(['withdrawn', 'dropped', 'confirmed'] as const).map((reason) => bridge(S, { type: 'question-resolved', requestId: 'request-1', reason }))]) {
      expect(bridged).toEqual({ session: [], chat: [], reference: null, taken: null, ended: null, asideId: null });
    }
    expect(JSON.stringify(raised)).not.toContain(PRIVATE);
  });
});

describe('conversation text has one route (V2; C10)', () => {
  it('reaches the chat whole, and the summary never, an action’s line apart', () => {
    const message = bridge(S, { type: 'message', turnId: 't1', role: 'assistant', itemId: 'i1', phase: 'final', text: PRIVATE, questions: [{ title: PRIVATE, options: [PRIVATE] }] });
    expect(message.session).toEqual([]);
    expect(message.chat).toEqual([{ kind: 'assistant', turnId: 't1', itemId: 'i1', workerId: null, phase: 'final', text: PRIVATE, cut: false, questions: [{ title: PRIVATE, options: [PRIVATE] }], model: null }]);

    // A message as it is written goes the same one way (M19, C3, C23): to the chat, and nothing of it to the summary.
    const delta = bridge(S, { type: 'message-delta', turnId: 't1', itemId: 'i1', phase: 'commentary', text: PRIVATE });
    expect(delta).toEqual({ session: [], chat: [{ kind: 'delta', turnId: 't1', itemId: 'i1', workerId: null, phase: 'commentary', text: PRIVATE }], reference: null, taken: null, ended: null, asideId: null });
    expect(bridge(S, { type: 'message-delta', turnId: 't1', itemId: 'i1', phase: null, text: '' }).chat).toEqual([{ kind: 'delta', turnId: 't1', itemId: 'i1', workerId: null, phase: null, text: '' }]);

    const notice = bridge(S, { type: 'notice', turnId: 't1', kind: 'turn-failed', detail: PRIVATE });
    expect(notice.session).toEqual([]);
    expect(notice.chat).toEqual([{ kind: 'notice', turnId: 't1', notice: 'turn-failed', step: null, detail: PRIVATE, bound: null, size: null }]);

    const echo = bridge(S, { type: 'message', turnId: 't1', role: 'user', itemId: 'u1', phase: null, text: PRIVATE });
    expect(JSON.stringify(echo)).not.toContain('secret');

    // The one conversation text that becomes a label goes as a line, which M14 then cleans.
    const action = bridge(S, { type: 'action-changed', turnId: 't1', kind: 'reading', line: PRIVATE });
    expect(action.session).toEqual([{ type: 'action-changed', sessionId: S, turnId: 't1', kind: 'reading', line: PRIVATE }]);
    expect(action.chat).toEqual([]);
  });

  it('never puts a failure’s kind or a notice’s detail into an event for the summary', () => {
    const ended = bridge(S, { type: 'turn-ended', turnId: 't1', outcome: 'failed', reported: true, failure: 'turn-failed' });
    expect(JSON.stringify(ended.session)).not.toContain('turn-failed');
  });
});

describe('what a session does, and what a worker says (M20a, V7; C13, C20, C30)', () => {
  const started: AgentEvent = { type: 'activity-started', turnId: 't1', itemId: 'a1', activityType: 'command', name: 'commandExecution', summary: 'rg --files', input: PRIVATE, files: [{ path: PRIVATE, line: 4 }], providerAt: 9 };
  const ended: AgentEvent = { type: 'activity-ended', turnId: 't1', itemId: 'a1', status: 'failed', output: PRIVATE, exitCode: 2, providerAt: 12, durationMs: 0 };

  it('hands an activity’s start and end to the chat alone: nothing of either reaches the summary', () => {
    const start = bridge(S, started);
    expect(start).toEqual({
      session: [], reference: null, taken: null, ended: null, asideId: null,
      chat: [{ kind: 'activity-started', turnId: 't1', itemId: 'a1', workerId: null, providerAt: 9, start: { type: 'command', name: 'commandExecution', summary: 'rg --files', input: PRIVATE, files: [{ path: PRIVATE, line: 4 }] } }],
    });
    const end = bridge(S, ended);
    expect(end).toEqual({
      session: [], reference: null, taken: null, ended: null, asideId: null,
      chat: [{ kind: 'activity-ended', turnId: 't1', itemId: 'a1', workerId: null, providerAt: 12, durationMs: 0, untimed: false, end: { status: 'failed', output: PRIVATE, exitCode: 2 } }],
    });
  });

  it('says a time and a duration the provider did not give as null: none is made up', () => {
    const start = bridge(S, { type: 'activity-started', turnId: 't1', itemId: 'a1', activityType: 'wait', name: 'sleep', summary: 'Waited' }).chat[0];
    expect(start).toMatchObject({ providerAt: null, start: { type: 'wait', name: 'sleep', summary: 'Waited' } });
    expect(bridge(S, { type: 'activity-ended', turnId: 't1', itemId: 'a1', status: 'completed' }).chat[0]).toMatchObject({ providerAt: null, durationMs: null, end: { status: 'completed' } });
    // An end whose start frame never came says that no duration of fat-g's is to be measured for it (C7).
    expect(bridge(S, { type: 'activity-ended', turnId: 't1', itemId: 'a1', status: 'completed', untimed: true }).chat[0]).toMatchObject({ untimed: true, durationMs: null });
  });

  it('carries everything a start and an end may say: an edit’s changes, a checklist’s steps, a thinking, a cut', () => {
    const cut = { fields: ['output' as const], output: { omitted: 4, at: 2 }, files: 0, steps: 0, changes: 0 };
    const start = bridge(S, { ...started, changes: [{ path: 'a.md', kind: 'write', text: 'x' }], steps: [{ text: 'one', state: 'pending' }], thinking: 'a thought', cut }).chat[0];
    expect(start).toMatchObject({ start: { changes: [{ path: 'a.md', kind: 'write', text: 'x' }], steps: [{ text: 'one', state: 'pending' }], thinking: 'a thought', cut } });
    const end = bridge(S, { ...ended, changes: [], steps: [{ text: 'one', state: 'completed' }], thinking: '', cut }).chat[0];
    expect(end).toMatchObject({ end: { changes: [], steps: [{ text: 'one', state: 'completed' }], thinking: '', cut } });
  });

  it('names the worker a worker item started in its body, and whose item an event is beside it (C20, C23)', () => {
    const paired = bridge(S, { type: 'activity-started', turnId: 't1', itemId: 'agent-1', activityType: 'worker', name: 'Agent', summary: 'Reads notes', pairedWorkerId: 'w1' }).chat[0];
    expect(paired).toMatchObject({ workerId: null, start: { type: 'worker', workerId: 'w1' } });
    const workers = bridge(S, { ...started, workerId: 'w1' }).chat[0];
    expect(workers).toMatchObject({ workerId: 'w1' });
    expect(workers !== undefined && 'start' in workers && 'workerId' in workers.start).toBe(false);
    expect(bridge(S, { ...ended, workerId: 'w1' }).chat[0]).toMatchObject({ workerId: 'w1' });
  });

  it('sends a worker’s message and its text as it is written to the chat with its id, and to the summary not at all', () => {
    const message = bridge(S, { type: 'message', turnId: 't1', role: 'assistant', itemId: 'w-final', phase: 'final', text: PRIVATE, workerId: 'w1' });
    expect(message).toEqual({ session: [], reference: null, taken: null, ended: null, asideId: null, chat: [{ kind: 'assistant', turnId: 't1', itemId: 'w-final', workerId: 'w1', phase: 'final', text: PRIVATE, cut: false, questions: [], model: null }] });
    const delta = bridge(S, { type: 'message-delta', turnId: 't1', itemId: 'w-final', phase: 'final', text: PRIVATE, workerId: 'w1' });
    expect(delta).toEqual({ session: [], reference: null, taken: null, ended: null, asideId: null, chat: [{ kind: 'delta', turnId: 't1', itemId: 'w-final', workerId: 'w1', phase: 'final', text: PRIVATE }] });
  });

  it('makes no echo of a worker’s instruction: it is no message of the user’s', () => {
    expect(bridge(S, { type: 'message', turnId: 't1', role: 'user', itemId: 'w-user', phase: null, text: PRIVATE, workerId: 'w1' })).toEqual({ session: [], chat: [], reference: null, taken: null, ended: null, asideId: null });
  });

  it('leaves what the agent list shows of a worker to the worker’s own events, as before', () => {
    expect(bridge(S, { type: 'worker-progressed', workerId: 'w1', kind: 'reading', file: 'notes.txt' }).chat).toEqual([]);
    expect(bridge(S, { type: 'worker-ended', workerId: 'w1', outcome: 'completed' }).chat).toEqual([]);
  });

  // M106 (V1; C14, C19, C20, C38): a sub-agent's model and agent definition, for the list and for its item.
  it('forwards a worker’s model and agent definition to the list and its item, a model only where it is a key, the definition cut to a line', () => {
    const started = bridge(S, { type: 'worker-started', workerId: 'w1', description: 'Reads notes', model: 'haiku', agentType: 'Explore\nmore' });
    expect(started.session).toEqual([{ type: 'worker-started', sessionId: S, workerId: 'w1', description: 'Reads notes', model: 'haiku', agentType: 'Explore' }]);
    expect(started.chat).toEqual([]);
    // A model the summary could not take as a key names nothing, and loses no worker.
    expect(bridge(S, { type: 'worker-started', workerId: 'w1', model: 'two words' }).session).toEqual([{ type: 'worker-started', sessionId: S, workerId: 'w1' }]);
    expect(bridge(S, { type: 'worker-model', workerId: 'w1', model: 'claude-haiku-4-5-20251001' })).toEqual({ session: [{ type: 'worker-model', sessionId: S, workerId: 'w1', model: 'claude-haiku-4-5-20251001' }], chat: [], reference: null, taken: null, ended: null, asideId: null });
    expect(bridge(S, { type: 'worker-model', workerId: 'w1', model: 'two words' }).session).toEqual([]);
    for (const event of [...started.session, ...bridge(S, { type: 'worker-model', workerId: 'w1', model: 'opus' }).session]) expect(SessionEventSchema.safeParse(event).success).toBe(true);
    const item = bridge(S, { type: 'activity-started', turnId: 't1', itemId: 'agent-1', activityType: 'worker', name: 'Agent', summary: 'Reads notes', pairedWorkerId: 'w1', model: 'claude-opus-5', agentType: 'Explore' }).chat[0];
    expect(item).toMatchObject({ start: { type: 'worker', workerId: 'w1', model: 'claude-opus-5', agentType: 'Explore' } });
    const unkeyed = bridge(S, { type: 'activity-started', turnId: 't1', itemId: 'agent-1', activityType: 'worker', name: 'Agent', summary: 'Reads notes', model: 'two words' }).chat[0];
    expect(unkeyed !== undefined && 'start' in unkeyed && 'model' in unkeyed.start).toBe(false);
  });
});

describe('the cuts for M14’s events (V46; C113)', () => {
  it('cuts an action’s line and file to their first line, at what the events take', () => {
    const long = `${'y'.repeat(MAX_LINE_INPUT + 300)}\nsecond line`;
    const [event] = bridge(S, { type: 'action-changed', turnId: 't1', kind: 'reading', line: `first line\nsecond line`, file: 'notes.txt' }).session;
    expect(event).toMatchObject({ line: 'first line', file: 'notes.txt' });
    // The schema refuses a longer line, so the bridge never sends one, whatever it was handed.
    const cut = bridge(S, { type: 'worker-started', workerId: 'w', description: long.slice(0, MAX_LINE_INPUT) }).session[0];
    expect(SessionEventSchema.safeParse(cut).success).toBe(true);
  });

  it('names a session from the first line of its first prompt, cut so the name’s event takes it', () => {
    expect(firstPromptName('Fix the login bug\n\nIt fails on Tuesdays.')).toBe('Fix the login bug');
    expect(firstPromptName('\n\n  \nSecond thoughts')).toBe('Second thoughts');
    const long = firstPromptName('z'.repeat(100_000));
    expect(long).toHaveLength(MAX_LINE_INPUT);
    expect(SessionEventSchema.safeParse({ type: 'name-reported', sessionId: S, name: long, source: 'first-message' }).success).toBe(true);
    expect(SessionEventSchema.safeParse({ type: 'name-reported', sessionId: S, name: 'z'.repeat(MAX_LINE_INPUT + 1), source: 'first-message' }).success).toBe(false);
  });
});

describe('an aside’s events (M20b, V7; C4, C25, C33)', () => {
  const A = 'aside-1';

  it('hands an aside’s message, its text as it is written, its activities and its notice to the chat under its id, and nothing to the summary', () => {
    const events: AgentEvent[] = [
      { type: 'message', turnId: 't9', role: 'assistant', itemId: 'i9', phase: 'final', text: PRIVATE, asideId: A, model: 'another-model' },
      { type: 'message-delta', turnId: 't9', itemId: 'i9', phase: 'final', text: PRIVATE, asideId: A },
      { type: 'activity-started', turnId: 't9', itemId: 'a9', activityType: 'read', name: 'read', summary: PRIVATE, asideId: A },
      { type: 'activity-ended', turnId: 't9', itemId: 'a9', status: 'completed', output: PRIVATE, asideId: A },
      { type: 'notice', turnId: 't9', kind: 'no-answer', asideId: A },
    ];
    for (const event of events) {
      const bridged = bridge(S, event);
      expect(bridged.asideId, event.type).toBe(A);
      expect(bridged.session, event.type).toEqual([]);
      expect(bridged.chat, event.type).toHaveLength(1);
    }
    // The model its reply named is the message's own (C7).
    expect(bridge(S, events[0] as AgentEvent).chat[0]).toMatchObject({ kind: 'assistant', model: 'another-model' });
  });

  it('gives the summary nothing of an aside’s turn: no start, no end and no status, while main is still told which turn was taken and which ended', () => {
    const started = bridge(S, { type: 'turn-started', turnId: 't9', providerTurnId: 'child-turn', asideId: A });
    expect(started).toMatchObject({ session: [], reference: null, asideId: A, taken: { turnId: 't9', providerTurnId: 'child-turn' } });
    const ended = bridge(S, { type: 'turn-ended', turnId: 't9', outcome: 'completed', reported: true, asideId: A });
    expect(ended.session).toEqual([]);
    expect(ended.asideId).toBe(A);
    // What ended and how is still said: main ends the aside's own turn by it.
    expect(ended.ended).toMatchObject({ turnId: 't9', outcome: 'completed' });
    // The same events without the aside's id are the session's, as they were.
    expect(bridge(S, { type: 'turn-started', turnId: 't9' }).asideId).toBeNull();
    expect(bridge(S, { type: 'turn-ended', turnId: 't9', outcome: 'completed', reported: true }).session).toHaveLength(1);
  });
});
